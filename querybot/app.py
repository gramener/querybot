from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from platformdirs import user_config_dir
from pydantic import BaseModel
from typing import List
import duckdb
import httpx
import json
import logging
import numpy as np
import os
import pandas as pd
import re
import math
import urllib.parse

# Custom JSON encoder to handle non-serializable values
class CustomJSONEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, (np.integer, np.floating, np.bool_)):
            return obj.item()
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        if isinstance(obj, pd.Series):
            return obj.tolist()
        if isinstance(obj, (pd.Timestamp, pd._libs.tslibs.timestamps.Timestamp)):
            return obj.isoformat()
        if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
            return None
        return super().default(obj)

load_dotenv()

config_dir = user_config_dir("dataquery")
app = FastAPI()

# Use custom JSON encoder for all responses
app.json_encoder = CustomJSONEncoder

# Initialize DuckDB and load extensions
con = duckdb.connect(":memory:")
con.execute("INSTALL excel")
con.execute("LOAD excel")
con.execute("INSTALL mysql")
con.execute("LOAD mysql")
con.execute("INSTALL httpfs")
con.execute("LOAD httpfs")

SYSTEM_PROMPT = (
    "You are an expert data analyst tasked with analyzing data using DuckDB SQL syntax. "
    "Based on the user's question, determine the appropriate analytical approach:\n\n"
    "CRITICAL: Column Name Handling\n"
    "1. ALWAYS use the EXACT column names as shown in the schema\n"
    "2. If a column name contains spaces or special characters, it MUST be quoted with double quotes\n"
    "3. Example: If schema shows \"Transaction Type\", use \"Transaction Type\" in queries\n"
    "4. Never modify or transform column names (e.g., don't change \"Transaction Type\" to TransactionType)\n"
    "5. Always check the schema first to get the exact column names\n\n"
    "For questions about complaints/issues/problems:\n"
    "- Use a simple but effective approach with LIKE operators\n"
    "- Example query structure:\n"
    "  SELECT \"Review Text\", COUNT(*) as Frequency\n"
    "  FROM dataset\n"
    "  WHERE LOWER(\"Review Text\") LIKE '%keyword1%'\n"
    "     OR LOWER(\"Review Text\") LIKE '%keyword2%'\n"
    "  GROUP BY \"Review Text\"\n"
    "  ORDER BY Frequency DESC\n"
    "For trends or patterns:\n"
    "- Use simple aggregations (COUNT, AVG, SUM)\n"
    "- Group by relevant columns\n"
    "- Always use LOWER() for case-insensitive text matching\n"
    "- Always quote column names with spaces\n\n"
    "For comparative analysis:\n"
    "- Use simple subqueries or window functions\n"
    "- Include HAVING clauses for filtered aggregations\n"
    "- Sort results meaningfully\n"
    "- Always quote column names with spaces\n\n"
    "Important rules:\n"
    "1. Always use simple, DuckDB-compatible SQL syntax\n"
    "2. Avoid complex string manipulations\n"
    "3. Use straightforward GROUP BY and aggregations\n"
    "4. Never use LIMIT, Display all results\n"
    "5. Focus on finding meaningful patterns in the data\n"
    "6. IMPORTANT: DuckDB has specific syntax limitations:\n"
    "   - Do NOT use UNION ALL for combining results\n"
    "   - Instead, use WITH clauses (CTEs) or separate queries\n"
    "   - For multiple aggregations, use separate queries or CTEs\n"
    "   - Example of combining results without UNION:\n"
    "     WITH issuer_stats AS (\n"
    "       SELECT 'Issuer' as category, \"Column Name\", ...\n"
    "       FROM table\n"
    "       GROUP BY \"Column Name\"\n"
    "     ),\n"
    "     region_stats AS (\n"
    "       SELECT 'Region' as category, \"Column Name\", ...\n"
    "       FROM table\n"
    "       GROUP BY \"Column Name\"\n"
    "     )\n"
    "     SELECT * FROM issuer_stats\n"
    "     UNION ALL\n"
    "     SELECT * FROM region_stats\n\n"
    "When working with dates in DuckDB:\n"
    "1. Never use DATE() function directly on columns\n"
    "2. Do NOT use julianday() function (it doesn't exist in DuckDB)\n"
    "3. For date conversions, use STRPTIME with multiple formats to handle various date inputs:\n"
    "   - STRPTIME(\"Column Name\", ['%Y-%m-%d', '%d-%m-%Y', '%m/%d/%Y', '%Y/%m/%d', '%d/%m/%Y', '%m-%d-%Y', '%d.%m.%Y', '%Y.%m.%d'])\n"
    "   - This will automatically try each format and convert to ISO 8601 (YYYY-MM-DD)\n"
    "4. For date differences, use DATE_DIFF('day', date1, date2) function\n"
    "5. For date comparisons, use the BETWEEN operator or simple comparison operators\n"
    "6. For date operations, use the following syntax:\n"
    "   - To subtract a time period from a date: date_column - INTERVAL '1 year'\n"
    "   - To add a time period to a date: date_column + INTERVAL '1 year'\n"
    "   - Example: CURRENT_DATE - INTERVAL '1 year'\n"
    "   - Supported intervals: 'year', 'month', 'day', 'hour', 'minute', 'second'\n"
    "   - For date ranges, use: date_column BETWEEN (CURRENT_DATE - INTERVAL '1 year') AND CURRENT_DATE\n\n"
    "For the output, follow this structure:\n"
    "1. Guess the objective of the user based on their query.\n"
    "2. Describe the steps to achieve this objective in SQL.\n"
    "3. Build the logic for the SQL query by identifying the necessary tables and relationships. Select the appropriate columns based on the user's question and the dataset.\n"
    "4. Write SQL to answer the question. Use DuckDB-compatible syntax.\n"
    "5. Possible Explanation of the query and results.\n\n"
    "Always ensure queries are compatible with DuckDB and provide clear insights."
)

# In-memory storage for uploaded datasets
datasets = {}

def quote_column_name(column_name: str) -> str:
    """Quote column names that contain spaces or special characters."""
    # Skip empty or None column names
    if not column_name:
        return column_name
        
    # Remove any existing quotes first
    column_name = column_name.strip('"')
    
    # Only quote if the column name contains spaces or special characters
    if ' ' in column_name or any(c in column_name for c in '[](){}<>+-*/=!@#$%^&|\\'):
        return f'"{column_name}"'
    return column_name

def process_sql_query(sql_query: str, schema_info: list) -> str:
    """Process SQL query to properly quote column names."""
    if not schema_info:
        return sql_query
        
    # Create a mapping of unquoted column names to quoted ones
    column_mapping = {}
    for col in schema_info:
        if col and len(col) > 0 and col[0]:  # Ensure we have valid column names
            original = col[0].strip('"')  # Remove any existing quotes
            quoted = quote_column_name(original)
            if original and quoted:  # Only add if both are non-empty
                column_mapping[original] = quoted
    
    # Sort column names by length (longest first) to avoid partial matches
    sorted_columns = sorted(column_mapping.keys(), key=len, reverse=True)
    
    # Replace column names in the query
    for original in sorted_columns:
        quoted = column_mapping[original]
        # Use word boundaries and ensure we don't match inside quotes
        pattern = r'(?<!")\b' + re.escape(original) + r'\b(?!")'
        sql_query = re.sub(pattern, quoted, sql_query)
    
    return sql_query

# Helper function to call LLM API
async def call_llm_system_prompt(user_input, model="gpt-4.1-mini", api_base=None, custom_system_prompt=None):
    # Use custom system prompt if provided, otherwise use default
    current_prompt = custom_system_prompt if custom_system_prompt else SYSTEM_PROMPT
    
    headers = {
        "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}:querybot",
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": current_prompt},
            {"role": "user", "content": user_input},
        ],
    }
    
    # Use custom API base URL if provided, otherwise use the default
    base_url = api_base if api_base else os.environ['OPENAI_API_BASE']
    
    async with httpx.AsyncClient() as client:
        # Check if the base URL already ends with /chat/completions
        url = base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions"
        response = await client.post(
            url,
            headers=headers,
            json=payload,
            timeout=30.0,  # Added timeout for safety
        )
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"]


class QueryRequest(BaseModel):
    dataset_name: str
    query: str
    file_path: str
    is_explanation: bool = False
    system_prompt: str | None = None  # Make system_prompt optional
    model: str = "gpt-4.1-mini"  # Default model
    api_base: str | None = None  # Optional custom API base URL

class AnalyzeFileRequest(BaseModel):
    file_paths: List[str]  # Now this can contain comma-separated paths


def is_remote_url(file_path: str) -> bool:
    """Check if the given path is a remote URL."""
    try:
        result = urllib.parse.urlparse(file_path)
        return all([result.scheme, result.netloc])
    except:
        return False

def get_schema_from_duckdb(file_path: str) -> tuple[str, str]:
    """Get schema using DuckDB's introspection capabilities."""
    try:
        file_extension = Path(file_path).suffix.lower()
        con = duckdb.connect(":memory:")

        # Handle different file types for both local and remote files
        if file_extension in [".csv", ".txt"]:
            # For CSV files, get schema without creating table
            schema_info = con.execute(f"DESCRIBE SELECT * FROM read_csv_auto('{file_path}') LIMIT 0").fetchall()
        elif file_extension == ".parquet":
            schema_info = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{file_path}') LIMIT 0").fetchall()
        elif file_extension == ".json":
            schema_info = con.execute(f"DESCRIBE SELECT * FROM read_json_auto('{file_path}') LIMIT 0").fetchall()
        elif file_extension == ".duckdb" and is_remote_url(file_path):
            # For remote DuckDB files
            con.execute(f"ATTACH '{file_path}' AS remote_db")
            tables = con.execute("SELECT name FROM remote_db.sqlite_master WHERE type='table'").fetchall()
            if not tables:
                raise ValueError("No tables found in remote DuckDB database")
            table_name = tables[0][0]
            schema_info = con.execute(f"DESCRIBE SELECT * FROM remote_db.{table_name} LIMIT 0").fetchall()
        elif file_extension == ".xlsx":
            if is_remote_url(file_path):
                raise ValueError("Remote Excel files are not supported")
            schema_info = con.execute(f"DESCRIBE SELECT * FROM read_excel('{file_path}') LIMIT 0").fetchall()
        elif file_extension == ".db":
            if is_remote_url(file_path):
                raise ValueError("Remote SQLite databases are not supported")
            con.execute("INSTALL sqlite")
            con.execute("LOAD sqlite")
            # Get list of tables directly from SQLite file
            tables = con.execute(f"SELECT name FROM sqlite_scan('{file_path}', 'sqlite_master') WHERE type='table'").fetchall()
            if not tables:
                raise ValueError("No tables found in SQLite database")
            table_name = tables[0][0]
            # Use sqlite_scan directly without attaching
            read_function = f"sqlite_scan('{file_path}', '{table_name}')"
            schema_info = con.execute(f"DESCRIBE SELECT * FROM {read_function} LIMIT 0").fetchall()
        else:
            raise ValueError(f"Unsupported file type: {file_extension}")

        # Generate schema description
        schema_description = (
            "CREATE TABLE dataset (\n"
            + ",\n".join([f"[{col[0]}] {col[1]}" for col in schema_info])
            + "\n);"
        )

        # Get sample data for better question suggestions (only for files that support it efficiently)
        sample_data = []
        if file_extension in [".csv", ".txt"]:
            sample_data = con.execute(f"SELECT * FROM read_csv_auto('{file_path}') LIMIT 5").fetchall()
        elif file_extension == ".parquet":
            sample_data = con.execute(f"SELECT * FROM read_parquet('{file_path}') LIMIT 5").fetchall()
        elif file_extension == ".json":
            sample_data = con.execute(f"SELECT * FROM read_json_auto('{file_path}') LIMIT 5").fetchall()
        elif file_extension == ".xlsx" and not is_remote_url(file_path):
            sample_data = con.execute("SELECT * FROM temp LIMIT 5").fetchall()
        elif file_extension in [".db", ".duckdb"]:
            # For database files, sample data is already handled above
            pass

        return schema_description, sample_data

    except Exception as e:
        logging.error(f"Error reading file {file_path}: {e}")
        raise
    finally:
        con.close()


def get_schema_from_mysql(connection_string: str) -> tuple[str, str]:
    """Get schema from MySQL database."""
    con = duckdb.connect(":memory:")
    try:
        # Use DuckDB's MySQL scanner
        con.execute("INSTALL mysql")
        con.execute("LOAD mysql")
        # Get schema without creating table
        schema_info = con.execute(f"DESCRIBE SELECT * FROM mysql_scan('{connection_string}') LIMIT 0").fetchall()
        sample_data = con.execute(f"SELECT * FROM mysql_scan('{connection_string}') LIMIT 5").fetchall()

        schema_description = (
            "CREATE TABLE dataset (\n"
            + ",\n".join([f"[{col[0]}] {col[1]}" for col in schema_info])
            + "\n);"
        )

        return schema_description, sample_data
    finally:
        con.close()


@app.get("/list-files")
async def list_files():
    return {"files": [f.name for f in Path(config_dir).glob("*.csv")]}


@app.get("/system-prompt")
async def get_system_prompt():
    return {"system_prompt": SYSTEM_PROMPT}


@app.post("/upload")
async def upload_csv(request: AnalyzeFileRequest):
    # Split the file paths and process each file
    uploaded_datasets = []

    for file_path in request.file_paths:
        dataset_name = Path(file_path).stem

        # Get schema and sample data using DuckDB
        schema_description, _ = get_schema_from_duckdb(file_path)

        # Generate suggested questions using LLM with schema and sample data
        user_prompt = (
            f"Dataset name: {dataset_name}\n"
            f"Schema: {schema_description}\n"
            "Please provide 5 suggested questions (ONLY QUESTIONS, NO EXPLANATION, NO Serial Numbers) that can be answered using duckDB queries on this dataset."
        )
        suggested_questions = await call_llm_system_prompt(user_prompt, "gpt-4.1-mini")

        uploaded_datasets.append({
                "dataset_name": dataset_name,
                "schema": schema_description,
                "suggested_questions": suggested_questions,
                "file_type": Path(file_path).suffix.lower(),
            })

    return {"uploaded_datasets": uploaded_datasets}


@app.post("/query")
async def query_data(request: QueryRequest):
    try:
        # Handle explanation requests differently
        if request.is_explanation:
            # Use the system prompt provided in the request for explanations
            system_prompt = request.system_prompt if request.system_prompt else SYSTEM_PROMPT

            # Create messages with the appropriate system prompt
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": request.query},
            ]

            # Call LLM with the specific system prompt
            headers = {
                "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}:querybot",
            }
            payload = {
                "model": request.model,
                "messages": messages,
            }

            # Use custom API base URL if provided, otherwise use the default
            api_base = request.api_base if request.api_base else os.environ['OPENAI_API_BASE']
            
            async with httpx.AsyncClient() as client:
                # Check if the base URL already ends with /chat/completions
                url = api_base if api_base.endswith("/chat/completions") else f"{api_base}/chat/completions"
                response = await client.post(
                    url,
                    headers=headers,
                    json=payload,
                    timeout=30.0,
                )
                response.raise_for_status()
                llm_response = response.json()["choices"][0]["message"]["content"]

            return JSONResponse(content={
                "llm_response": llm_response
            })

        # Split the file paths and process each file
        file_paths = [path.strip() for path in request.file_path.split(",")]

        # Define dtype_mapping for DuckDB
        dtype_mapping = {
            "object": "TEXT",
            "int64": "INTEGER",
            "float64": "FLOAT",
            "bool": "BOOLEAN",
            "datetime64[ns]": "DATETIME",
        }

        # Process each file and create tables in DuckDB
        for file_path in file_paths:
            file_extension = Path(file_path).suffix.lower()
            if file_extension not in ['.csv', '.parquet', '.json', '.duckdb', '.xlsx', '.db']:
                return JSONResponse(
                    content={"error": f"File type {file_extension} is not supported"}, 
                    status_code=400
                )
            
            # Get dataset name
            dataset_name = os.path.splitext(os.path.basename(file_path))[0]
            dataset_name = re.sub(r'[^a-zA-Z0-9_]', '_', dataset_name)
            if dataset_name[0].isdigit():
                dataset_name = f"t_{dataset_name}"

            try:
                # Get schema without creating table
                if file_extension in ['.csv', '.txt']:
                    schema_info = con.execute(f"DESCRIBE SELECT * FROM read_csv_auto('{file_path}') LIMIT 0").fetchall()
                    read_function = f"read_csv_auto('{file_path}')"
                elif file_extension == '.parquet':
                    schema_info = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{file_path}') LIMIT 0").fetchall()
                    read_function = f"read_parquet('{file_path}')"
                elif file_extension == '.json':
                    schema_info = con.execute(f"DESCRIBE SELECT * FROM read_json_auto('{file_path}') LIMIT 0").fetchall()
                    read_function = f"read_json_auto('{file_path}')"
                elif file_extension == '.xlsx':
                    schema_info = con.execute(f"DESCRIBE SELECT * FROM read_excel('{file_path}') LIMIT 0").fetchall()
                    read_function = f"read_excel('{file_path}')"
                elif file_extension == '.db':
                    # First attach the SQLite database
                    con.execute(f"INSTALL sqlite")
                    con.execute(f"LOAD sqlite")
                    # Get list of tables directly from SQLite file
                    tables = con.execute(f"SELECT name FROM sqlite_scan('{file_path}', 'sqlite_master') WHERE type='table'").fetchall()
                    if not tables:
                        raise ValueError("No tables found in SQLite database")
                    table_name = tables[0][0]
                    # Use sqlite_scan directly without attaching
                    read_function = f"sqlite_scan('{file_path}', '{table_name}')"
                    schema_info = con.execute(f"DESCRIBE SELECT * FROM {read_function} LIMIT 0").fetchall()
                elif file_extension == '.duckdb':
                    con.execute(f"ATTACH '{file_path}' AS remote_db")
                    tables = con.execute("SELECT name FROM remote_db.sqlite_master WHERE type='table'").fetchall()
                    if not tables:
                        raise ValueError("No tables found in DuckDB database")
                    table_name = tables[0][0]
                    schema_info = con.execute(f"DESCRIBE SELECT * FROM remote_db.{table_name} LIMIT 0").fetchall()
                    read_function = f"remote_db.{table_name}"
            except Exception as e:
                return JSONResponse(
                    content={"error": f"Error reading file: {str(e)}"}, 
                    status_code=400
                )
            
            schema_description = (
                f"CREATE TABLE {dataset_name} (\n"
                + ",\n".join([f"[{col[0]}] {col[1]}" for col in schema_info])
                + "\n);"
            )

            # Store dataset info with file path
            datasets[dataset_name] = {
                "schema_description": schema_description,
                "file_path": file_path,
                "read_function": read_function
            }

        # Rest of your existing query_data logic
        dataset_schemas = ""
        for name, dataset in datasets.items():
            schema_description = dataset.get("schema_description")
            file_path = dataset.get("file_path")
            read_function = dataset.get("read_function")
            if schema_description and isinstance(schema_description, str):
                dataset_schemas += f"Dataset name: {name}\nFile path: {file_path}\nSchema: {schema_description}\nNote: Use {read_function} in queries\n\n"

        # User query
        user_query = request.query

        # Construct LLM prompt
        llm_prompt = (
            f"Here are the datasets available:\n{dataset_schemas}"
            f"Please write an duckDB query for the following question:\n{user_query}"
        )

        # Call LLM with the prompt
        llm_response = await call_llm_system_prompt(
            llm_prompt, 
            request.model, 
            request.api_base,
            request.system_prompt
        )

        # Extract the SQL query from the response
        sql_query_match = re.search(r"```sql\n(.*?)\n```", llm_response, re.DOTALL)
        if not sql_query_match:
            # Try alternative formats
            sql_query_match = re.search(r"```\n(.*?)\n```", llm_response, re.DOTALL)
            if not sql_query_match:
                return JSONResponse(content={
                    "error": "Failed to extract SQL query from the LLM response.",
                    "llm_response": llm_response,  # Include the full response for debugging
                    "prompt_used": llm_prompt  # Include the prompt that was used
                }, status_code=400)

        sql_query = sql_query_match.group(1).strip()
        
        # Process the SQL query to properly quote column names
        sql_query = process_sql_query(sql_query, schema_info)
        
        # Fix common date syntax issues in DuckDB
        # Replace DATE() function with STRPTIME for multiple date formats
        date_func_pattern = r'DATE\s*\(\s*\[?([^)\]]+)\]?\s*\)'
        sql_query = re.sub(date_func_pattern, r"STRPTIME(\1, ['%Y-%m-%d', '%d-%m-%Y', '%m/%d/%Y', '%Y/%m/%d', '%d/%m/%Y', '%m-%d-%Y', '%d.%m.%Y', '%Y.%m.%d'])", sql_query)
        
        # Replace julianday() function with proper DuckDB date diff
        julianday_pattern = r'julianday\s*\(\s*\[?([^)\]]+)\]?\s*\)\s*-\s*julianday\s*\(\s*\[?([^)\]]+)\]?\s*\)'
        sql_query = re.sub(julianday_pattern, r"DATE_DIFF('day', STRPTIME(\2, ['%Y-%m-%d', '%d-%m-%Y', '%m/%d/%Y', '%Y/%m/%d', '%d/%m/%Y', '%m-%d-%Y', '%d.%m.%Y', '%Y.%m.%d']), STRPTIME(\1, ['%Y-%m-%d', '%d-%m-%Y', '%m/%d/%Y', '%Y/%m/%d', '%d/%m/%Y', '%m-%d-%Y', '%d.%m.%Y', '%Y.%m.%d']))", sql_query)
        
        # Replace CAST to INTEGER with string comparison for invoice numbers
        invoice_cast_pattern = r'CAST\s*\(\s*([^)]+)\s*AS\s*INTEGER\s*\)'
        sql_query = re.sub(invoice_cast_pattern, r'\1', sql_query)
        
        # Log the extracted SQL query (for debugging)
        print(f"Extracted SQL Query: {sql_query}")

        # Execute the generated SQL query
        try:
            result = con.execute(sql_query).fetchdf()
        except Exception as query_error:
            # No need for special date handling anymore
            return JSONResponse(content={
                "error": f"Error executing query: {str(query_error)}",
                "generated_query": sql_query,
                "llm_response": llm_response
            }, status_code=400)

        # Convert any non-JSON serializable types to compatible formats
        result = result.apply(
            lambda col: col.map(lambda x: x.tolist() if isinstance(x, np.ndarray) else x)
        )
        
        # Handle non-JSON-compliant float values (NaN, inf) and Timestamp objects
        def sanitize_json_value(x):
            if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
                return None
            if isinstance(x, (pd.Timestamp, pd._libs.tslibs.timestamps.Timestamp)):
                return x.isoformat()
            return x
            
        # Use map instead of applymap as per deprecation warning
        for col in result.columns:
            result[col] = result[col].map(sanitize_json_value)
        
        # Convert to dict and ensure all NaN values are handled
        result_dict = result.to_dict(orient="records")
        for row in result_dict:
            for key, value in row.items():
                if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
                    row[key] = None
        
        # Respond with the results
        if isinstance(llm_response, float):
            if (
                llm_response == float("inf")
                or llm_response == float("-inf")
                or (isinstance(llm_response, float) and llm_response != llm_response)
            ):
                llm_response = None  # or set to 0, depending on your needs
        return JSONResponse(
            content={
                "result": result_dict,
                "generated_query": sql_query,
                "llm_response": llm_response
            }
        )

    except Exception as e:
        return JSONResponse(content={
            "error": str(e),
            "llm_response": llm_response if 'llm_response' in locals() else None,
            "generated_query": sql_query if 'sql_query' in locals() else None,
            "prompt_used": llm_prompt if 'llm_prompt' in locals() else None
        }, status_code=400)


class SettingsRequest(BaseModel):
    key: str
    base: str


@app.post("/settings")
async def save_settings(request: SettingsRequest):
    # Save the settings to the environment variables
    os.environ["OPENAI_API_KEY"] = request.key
    os.environ["OPENAI_API_BASE"] = request.base
    with open(os.path.join(config_dir, "settings.json"), "w") as f:
        json.dump({"OPENAI_API_KEY": request.key, "OPENAI_API_BASE": request.base}, f)
    return {"status": "Settings saved successfully"}


# Mount static files directory LAST
static_dir = os.path.join(os.path.dirname(__file__), "static")
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")


def main():
    import uvicorn

    logger = logging.getLogger(__name__)
    PORT = int(os.getenv("PORT", 8001))

    if not os.path.exists(config_dir):
        os.makedirs(config_dir)
    if os.path.exists(os.path.join(config_dir, "settings.json")):
        with open(os.path.join(config_dir, "settings.json"), "r") as f:
            for key, value in json.load(f).items():
                os.environ[key] = value
    try:
        uvicorn.run(app, host="0.0.0.0", port=PORT)
    except BaseException as e:
        logger.error(f"Running locally. Cannot be accessed from outside: {e}")
        uvicorn.run(app, host="127.0.0.1", port=PORT)


if __name__ == "__main__":
    main()
