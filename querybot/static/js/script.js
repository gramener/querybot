import { html, render } from "https://cdn.jsdelivr.net/npm/lit-html/lit-html.js";
import { unsafeHTML } from "https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";
import { Chart, registerables } from "https://cdn.jsdelivr.net/npm/chart.js@4/+esm";

// Initialize Chart.js
Chart.register(...registerables);

const marked = new Marked();

const $openaiApiKey = document.getElementById("openai-api-key");
const $openaiApiBase = document.getElementById("openai-api-base");
const $toast = document.getElementById("toast");
const toast = new bootstrap.Toast($toast);

// Add variables to track query results and chart instance
let latestQueryResult = [];
let latestChart;
let recentFilePaths = JSON.parse(
  localStorage.getItem("recentFilePaths") || "[]"
);
let recentQueries = JSON.parse(
  localStorage.getItem("recentQueries") || "{}"
);

function notify(cls, title, message) {
  $toast.querySelector(".toast-title").textContent = title;
  $toast.querySelector(".toast-body").textContent = message;
  const $toastHeader = $toast.querySelector(".toast-header");
  $toastHeader.classList.remove(
    "text-bg-success",
    "text-bg-danger",
    "text-bg-warning",
    "text-bg-info"
  );
  $toastHeader.classList.add(`text-bg-${cls}`);
  toast.show();
}

// Define loading template
const loading = html` <div class="card">
  <div class="card-body text-center">
    <div class="spinner-border" role="status">
      <span class="d-none">Loading...</span>
    </div>
    <p class="mt-2">Loading...</p>
  </div>
</div>`;

// Consolidate common DOM element selections
const DOM = {
  output: () => document.getElementById("output"),
  responseOutput: () => document.getElementById("responseOutput"),
  queryInput: () => document.getElementById("queryInput"),
  filePathInput: () => document.getElementById("filePathInput"),
  executeButton: () => document.getElementById("executeButton"),
  questionList: () => document.getElementById("suggested-questions"),
  recentPaths: () => document.getElementById("recent-paths"),
  recentQueries: () => document.getElementById("recent-queries"),
};

// Add functions to manage file paths in localStorage
function addFilePath(path) {
  if (!path) return;
  // Remove if exists and add to front
  recentFilePaths = recentFilePaths.filter((p) => p !== path);
  recentFilePaths.unshift(path);
  // Keep only 5 recent paths
  if (recentFilePaths.length > 5) recentFilePaths.pop();
  localStorage.setItem("recentFilePaths", JSON.stringify(recentFilePaths));
  renderRecentPaths();
}

function clearRecentPaths() {
  recentFilePaths = [];
  localStorage.removeItem("recentFilePaths");
  renderRecentPaths();
}

function renderRecentPaths() {
  const recentPathsEl = DOM.recentPaths();
  if (!recentPathsEl) return;

  if (recentFilePaths.length === 0) {
    render(html``, recentPathsEl);
    return;
  }

  const template = html`
    <div class="mt-2 mb-3">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <h6 class="mb-0">Recent Files:</h6>
        <button
          class="btn btn-sm btn-outline-danger"
          @click=${() => clearRecentPaths()}
        >
          <i class="bi bi-x-circle"></i> Clear
        </button>
      </div>
      <div class="d-flex flex-wrap gap-1">
        ${recentFilePaths.map(
          (path) => html`
            <button
              class="btn btn-sm btn-outline-secondary"
              @click=${() => selectPath(path)}
              title=${path}
            >
              ${path.split('/').pop().split('\\').pop()}
            </button>
          `
        )}
      </div>
    </div>
  `;
  render(template, recentPathsEl);
}

function selectPath(path) {
  const filePathInput = DOM.filePathInput();
  if (filePathInput) {
    filePathInput.value = path;
    // Automatically load the file
    loadFile();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const loadFileButton = document.getElementById("loadFileButton");
  const executeButton = DOM.executeButton();

  if (loadFileButton) {
    loadFileButton.addEventListener("click", loadFile);
  }
  if (executeButton) {
    executeButton.addEventListener("click", executeQuery);
  }
  
  // Load default system prompt
  loadDefaultSystemPrompt();
  // Use event delegation to handle dynamically created elements
  document.body.addEventListener("click", function (event) {
    if (event.target.classList.contains("suggested-question")) {
      event.preventDefault(); // Prevent default link behavior
      const queryInput = DOM.queryInput();
      if (queryInput) {
        queryInput.value = event.target.textContent; // Set input value
        executeButton.click(); // Submit query
      }
    }
  });

  // Initialize the output area
  const output = DOM.output();
  if (output) {
    render(html``, output);
  }

  // Initialize recent paths display
  renderRecentPaths();

  // Initialize recent queries display
  renderRecentQueries();
});

// Function to load default system prompt
async function loadDefaultSystemPrompt() {
  const systemPromptTextarea = document.getElementById("systemPromptTextarea");
  if (!systemPromptTextarea) return;
  
  try {
    const response = await fetch("/system-prompt");
    if (response.ok) {
      const data = await response.json();
      systemPromptTextarea.value = data.system_prompt;
    }
  } catch (error) {
    console.error("Failed to load system prompt:", error);
  }
}

function renderOutput(data) {
  const output = document.getElementById("output");
  if (!output) {
    console.error("Output element not found");
    return;
  }

  // Render output for all datasets
  const template = html`
    <div>
      ${data.uploaded_datasets.map(
        (dataset, index) => html`
          <div class="card mb-3">
            <div class="card-header">
              <h5>
                Dataset ${index + 1}: ${dataset.dataset_name}
                <span class="badge bg-secondary">${dataset.file_type}</span>
              </h5>
            </div>
            <div class="card-body">
              <h6 class="card-title">Schema:</h6>
              <table class="table table-bordered">
                <thead>
                  <tr>
                    <th>Column Name</th>
                    <th>Data Type</th>
                  </tr>
                </thead>
                <tbody>
                  ${parseSchema(dataset.schema).map(
                    (col) => html`
                      <tr>
                        <td>${col.name}</td>
                        <td>${col.type}</td>
                      </tr>
                    `
                  )}
                </tbody>
              </table>
              <h6 class="card-title">Suggested Questions:</h6>
              <div class="list-group">
                ${dataset.suggested_questions
                  .split("\n")
                  .filter((question) => question.trim())
                  .map(
                    (question) =>
                      html` <a
                        class="list-group-item suggested-question"
                        href="#"
                        >${question}</a
                      >`
                  )}
              </div>
            </div>
          </div>
        `
      )}
    </div>
  `;
  render(template, output);
}

function parseSchema(schemaString) {
  // Match the table creation syntax with column definitions
  const match = schemaString.match(/\(([\s\S]*?)\)/); // Match everything inside parentheses
  if (!match) {
    renderError("Invalid schema format. Unable to extract column definitions.");
    return [];
  }
  const columnDefinitions = match[1]
    .split(",")
    .map((col) => col.trim())
    .filter(Boolean); // Remove empty strings
  // Parse each column definition into name and type
  return columnDefinitions.map((colDef) => {
    const parts = colDef.match(/\[([^\]]+)\] (\w+)/); // Match [column_name] data_type
    if (!parts) {
      return { name: "Unknown", type: "Unknown" };
    }
    return {
      name: parts[1], // Extract column name
      type: parts[2], // Extract data type
    };
  });
}

// Simplified error handling
function renderError(errorMessage) {
  const chartCode = document.getElementById("chart-code");
  const errorTemplate = html`
    <div class="alert alert-danger" role="alert">
      <strong>Error:</strong> ${errorMessage}
    </div>
  `;

  render(errorTemplate, DOM.output() || DOM.responseOutput());
}

// Update executeQuery function to include explanation functionality
async function executeQuery() {
  const responseOutput = DOM.responseOutput();
  if (!responseOutput) return;

  render(loading, responseOutput);
  const query = DOM.queryInput()?.value.trim();
  const filePath = DOM.filePathInput()?.value.trim();
  const modelSelect = document.getElementById("modelSelect");
  const model = modelSelect.value;

  // Check if the selected model has a custom base URL
  const selectedOption = modelSelect.options[modelSelect.selectedIndex];
  const customBaseUrl = selectedOption.dataset.baseUrl;

  if (!query) {
    renderError("Please enter a valid query.");
    return;
  }

  try {
    // Get custom system prompt if provided
    const systemPromptTextarea = document.getElementById("systemPromptTextarea");
    const customSystemPrompt = systemPromptTextarea?.value.trim();

    // Prepare the request body
    const requestBody = {
      dataset_name: "dataset",
      query,
      file_path: filePath,
      extract_sql: true,
      model,
    };

    // Add custom system prompt if provided
    if (customSystemPrompt) {
      requestBody.system_prompt = customSystemPrompt;
    }

    // Add custom base URL if available
    if (customBaseUrl) {
      requestBody.api_base = customBaseUrl;
    }

    const response = await fetch("/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    let result;
    try {
      result = await response.json();
    } catch (jsonError) {
      const errorTemplate = html`
        <div class="alert alert-danger" role="alert">
          <h5>Error parsing JSON response: ${jsonError.message}</h5>
          <hr />
          <p>This might be due to invalid values in the data. Please try a different query or dataset.</p>
        </div>
      `;
      render(errorTemplate, responseOutput);
      return;
    }
    if (!response.ok) {
      const errorTemplate = html`
        <div class="alert alert-danger" role="alert">
          <h5>Error: ${result.error}</h5>
          ${result.llm_response
            ? html`
                <hr />
                <h6>LLM Response:</h6>
                <div>${unsafeHTML(marked.parse(result.llm_response))}</div>
              `
            : ""}
        </div>
      `;
      render(errorTemplate, responseOutput);
      return;
    }

    // Store the latest query result
    latestQueryResult = result.result;

    // Save the query to recent queries
    addRecentQuery(query, result.result);
    renderRecentQueries();

    const queryOutput = html`
      <div class="card">
        <div class="card-header">
          <h5>Query Result</h5>
        </div>
        <div class="card-body">
          <h6>Response from LLM:</h6>
          <div>${unsafeHTML(marked.parse(result.llm_response))}</div>
          <h6>SQL Query Execution Result:</h6>
          <div
            id="sqlResultTable"
            class="table-responsive"
            style="max-height: 50vh;"
          ></div>
          <div class="mt-3">
            <div class="row align-items-center g-2">
              <div class="col-2">
                <button
                  class="btn btn-primary me-2"
                  @click=${() => downloadCSV(result.result, "query_result.csv")}
                >
                  <i class="bi bi-download"></i> Download CSV
                </button>
              </div>
              <div class="col-8">
                <input
                  type="text"
                  id="chart-input"
                  class="form-control"
                  placeholder="Describe what you want to chart"
                  value="Draw the most appropriate chart to visualize this data"
                />
              </div>
              <div class="col-2">
                <button
                  id="chart-button"
                  class="btn btn-primary"
                  @click=${() => generateChart()}
                >
                  <i class="bi bi-bar-chart-line"></i> Draw Chart
                </button>
              </div>
            </div>
            <div class="row mt-3">
              <div class="col-12">
                <div id="chart-container" class="mt-3" style="display: none;">
                  <canvas id="chart"></canvas>
                </div>
                <div id="chart-code" class="mt-3"></div>
              </div>
            </div>
          </div>
          <div class="row mt-2">
            <div class="col-md-8">
              <input
                type="text"
                id="additionalPrompt"
                class="form-control"
                placeholder="Optional: Add specific instructions for the explanation..."
              />
            </div>
            <div class="col-md-4">
              <button
                class="btn btn-info"
                @click=${() => explainResults(result.result, query)}
              >
                <i class="bi bi-lightbulb"></i> Explain Results
              </button>
            </div>
          </div>
          <div id="explanationOutput" class="mt-3"></div>
        </div>
      </div>
    `;

    render(queryOutput, responseOutput);
    document.getElementById("sqlResultTable").innerHTML = generateTable(
      result.result
    );
  } catch (error) {
    renderError(error.message);
  }
}

// Add new explainResults function
async function explainResults(data, originalQuery) {
  const explanationOutput = document.getElementById("explanationOutput");
  const additionalPrompt = document
    .getElementById("additionalPrompt")
    ?.value.trim();
  const modelSelect = document.getElementById("modelSelect");
  const model = modelSelect.value;

  // Check if the selected model has a custom base URL
  const selectedOption = modelSelect.options[modelSelect.selectedIndex];
  const customBaseUrl = selectedOption.dataset.baseUrl;

  render(loading, explanationOutput);

  try {
    const systemPrompt = `You are a friendly data interpreter helping non-technical and technical users understand their data. Your task is to:
1. Analyze the data results in relation to the original question
2. Provide clear explanations using plain language
3. Point out specific values and patterns in the data
4. Highlight any interesting or unexpected findings
5. Suggest potential follow-up questions if relevant
Remember to be specific and reference actual values from the data to support your analysis.`;

    const formattedData = data
      .map((row, index) => {
        return `Row ${index + 1}: ${JSON.stringify(row, null, 2)}`;
      })
      .join("\n");

    const userMessage = additionalPrompt
      ? `Question asked: "${originalQuery}"\nAdditional instructions: ${additionalPrompt}\n\nData Results:\n${formattedData}`
      : `Question asked: "${originalQuery}"\n\nData Results:\n${formattedData}`;

    // Prepare the request body
    const requestBody = {
      dataset_name: "explanation",
      query: userMessage,
      file_path: DOM.filePathInput()?.value.trim() || "",
      system_prompt: systemPrompt,
      is_explanation: true,
      model,
    };

    // Add custom base URL if available
    if (customBaseUrl) {
      requestBody.api_base = customBaseUrl;
    }

    const response = await fetch("/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok)
      throw new Error(`Error getting explanation: ${response.statusText}`);

    let result;
    try {
      result = await response.json();
    } catch (jsonError) {
      throw new Error(`Error parsing explanation response: ${jsonError.message}`);
    }
    const explanationTemplate = html`
      <div class="card">
        <div class="card-header">
          <h6>Answer Analysis</h6>
        </div>
        <div class="card-body">
          <p class="fw-bold">Question: ${originalQuery}</p>
          ${additionalPrompt
            ? html`<p class="text-muted">
                Additional Instructions: ${additionalPrompt}
              </p>`
            : ""}
          <hr />
          ${unsafeHTML(marked.parse(result.llm_response))}
        </div>
      </div>
    `;

    render(explanationTemplate, explanationOutput);
  } catch (error) {
    renderError(`Failed to get explanation: ${error.message}`);
  }
}

// Optimized loadFile function
async function loadFile() {
  const output = DOM.output();
  const filePath = DOM.filePathInput()?.value.trim();

  if (!output || !filePath) {
    renderError("Please enter a valid file path.");
    return;
  }

  render(loading, output);
  try {
    const filePaths = filePath.split(/\s*,\s*/);
    const response = await fetch("/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_paths: filePaths }),
    });

    if (!response.ok)
      throw new Error(`Error loading file: ${response.statusText}`);

    let data;
    try {
      data = await response.json();
    } catch (jsonError) {
      throw new Error(`Error parsing file data: ${jsonError.message}`);
    }
    renderOutput(data);
    DOM.executeButton()?.removeAttribute("disabled");

    // Store each file path individually in localStorage
    filePaths.forEach((path) => {
      if (path) addFilePath(path);
    });

    // Render recent queries for this specific file
    renderRecentQueries();
  } catch (error) {
    console.error(error);
    renderError(error.message);
  }
}

// Helper function to generate an HTML table from data
function generateTable(data) {
  if (!Array.isArray(data) || !data.length) return "<p>No data available</p>";

  const headers = Object.keys(data[0]);
  return `
    <table class="table table-bordered table-striped">
      <thead>
        <tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${data
          .map(
            (row) =>
              `<tr>${headers
                .map((header) => `<td>${row[header] ?? ""}</td>`)
                .join("")}</tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

// Optimized CSV conversion and download
function convertToCSV(data) {
  if (!Array.isArray(data) || !data.length) return "";

  const headers = Object.keys(data[0]);
  return [
    headers.join(","),
    ...data.map((row) =>
      headers.map((header) => JSON.stringify(row[header] ?? "")).join(",")
    ),
  ].join("\n");
}

function downloadCSV(data, filename = "data.csv") {
  const csv = convertToCSV(data);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });

  if (navigator.msSaveBlob) {
    navigator.msSaveBlob(blob, filename);
    return;
  }

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function listFiles() {
  const output = DOM.output();
  render(loading, output);

  try {
    const response = await fetch("/list-files");
    if (!response.ok)
      throw new Error(`Error listing files: ${response.statusText}`);

    const data = await response.json();

    const template = html`
      <div class="card mb-3">
        <div class="card-header">
          <h5>Available Files</h5>
        </div>
        <div class="card-body">
          <div class="list-group">
            ${data.files.map(
              (file) => html`
                <button
                  class="list-group-item list-group-item-action"
                  @click=${() => selectPath(file)}
                >
                  ${file}
                </button>
              `
            )}
          </div>
        </div>
      </div>
    `;

    render(template, output);
  } catch (error) {
    renderError(error.message);
  }
}

document
  .getElementById("settings")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    document.querySelector("#settings .loading").classList.remove("d-none");
    let response;
    try {
      response = await fetch("/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: $openaiApiKey.value,
          base: $openaiApiBase.value,
        }),
      });
    } catch (e) {
      return notify("danger", "Could not save settings", e.message);
    } finally {
      document.querySelector("#settings .loading").classList.add("d-none");
    }
    if (!response.ok)
      return notify("danger", "Could not save settings", await response.text());
    localStorage.setItem("localDataChatOpenAIAPIKey", $openaiApiKey.value);
    localStorage.setItem("localDataChatOpenAIAPIBase", $openaiApiBase.value);
    document.querySelector("#settings .saved").classList.remove("d-none");
    setTimeout(() => {
      document.querySelector("#settings .saved").classList.add("d-none");
      document.querySelector("#settings").classList.remove("show");
    }, 2000);
  });

document.querySelector("#openai-api-key").value = localStorage.getItem(
  "localDataChatOpenAIAPIKey"
);
document.querySelector("#openai-api-base").value =
  localStorage.getItem("localDataChatOpenAIAPIBase") ??
  "https://llmfoundry.straive.com/openai/v1";
if (!document.querySelector("#openai-api-key").value)
  document.querySelector("#settings").classList.add("show");

// Add function to generate charts
async function generateChart() {
  const chartInput = document.getElementById("chart-input").value.trim();
  const chartContainer = document.getElementById("chart-container");
  const chartCode = document.getElementById("chart-code");
  const model = document.getElementById("modelSelect").value;

  if (!latestQueryResult || latestQueryResult.length === 0) {
    renderError("No data available for charting.");
    return;
  }

  chartContainer.style.display = "block";
  render(loading, chartCode);

  try {
    // Create a sample of the data for the prompt
    const dataSample = latestQueryResult.slice(0, 5);

    // Define a specialized system prompt for chart generation
    const chartSystemPrompt = `You are an expert data visualization developer specializing in Chart.js.

IMPORTANT INSTRUCTIONS:
1. You MUST return valid JavaScript code for Chart.js inside a code block marked with \`\`\`js and ending with \`\`\`.
2. Your code MUST create a chart using the Chart.js library.
3. Do NOT include explanations outside the code block.
4. The code must be executable as-is.
5. The Chart.js library is already imported.
6. The data variable is already available as 'data'.
7. Use document.getElementById("chart") to access the canvas.
8. Your code must return the Chart instance.

The response format MUST be:

\`\`\`js
// Your Chart.js code here
return new Chart(
  document.getElementById("chart"),
  {
    type: "appropriate-chart-type",
    data: {
      // Use data variable here
    },
    options: {
      // Chart options here
    }
  }
);
\`\`\``;

    const response = await fetch("/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataset_name: "chart",
        query: `Create a Chart.js visualization based on this request: "${chartInput}".

Here's a sample of the data (the full dataset will be available as 'data' variable):
${JSON.stringify(dataSample, null, 2)}

The full dataset has ${latestQueryResult.length} records.

Remember: Return ONLY JavaScript code in a code block that creates and returns a Chart instance using Chart.js.`,
        file_path: DOM.filePathInput()?.value.trim(),
        is_explanation: true, // Use the explanation path to bypass SQL extraction
        system_prompt: chartSystemPrompt,
        model,
      }),
    });

    let result;
    try {
      result = await response.json();
    } catch (jsonError) {
      renderError(`Error parsing chart generation response: ${jsonError.message}`);
      return;
    }

    if (!response.ok) {
      renderError(`Error generating chart: ${result.error || "Unknown error"}`);
      return;
    }

    // Use improved code extraction function
    const code = extractCodeFromMarkdown(result.llm_response);

    if (!code) {
      renderError(
        "Could not extract chart code from response. The LLM did not provide code in a proper ```js code block format."
      );
      return;
    }

    // Display the generated code
    render(
      html`<pre><code class="language-javascript">${code}</code></pre>`,
      chartCode
    );

    // Clear previous chart if it exists
    if (latestChart) {
      latestChart.destroy();
    }

    // Execute the code to create the chart
    try {
      const chartFunction = new Function("Chart", "data", code);
      latestChart = chartFunction(Chart, latestQueryResult);
    } catch (execError) {
      renderError(`Error executing chart code: ${execError.message}`);
      console.error("Chart execution error:", execError);
    }
  } catch (error) {
    renderError(`Failed to generate chart: ${error.message}`);
    console.error("Chart generation error:", error);
  }
}

// Improved helper function to extract code from markdown with better pattern matching
function extractCodeFromMarkdown(markdown) {
  // Try different code block patterns
  const patterns = [
    /```js\s*\n([\s\S]*?)\n```/,
    /```javascript\s*\n([\s\S]*?)\n```/,
    /```\s*\n([\s\S]*?)\n```/,
    /```([\s\S]*?)```/
  ];

  for (const pattern of patterns) {
    const match = markdown.match(pattern);
    if (match && match[1]) {
      // Verify it contains Chart.js code
      if (
        match[1].includes("new Chart") &&
        match[1].includes('document.getElementById("chart")')
      ) {
        return match[1].trim();
      }
    }
  }
  return null;
}

// Add functions to manage recent queries in localStorage
function addRecentQuery(query, result) {
  if (!query) return;

  const filePath = DOM.filePathInput()?.value.trim() || "default";

  const queryData = {
    query,
    timestamp: new Date().toISOString(),
    result: result.slice(0, 3) // Store only first 3 results for brevity
  };

  // Initialize the array for this file path if it doesn't exist
  if (!recentQueries[filePath]) {
    recentQueries[filePath] = [];
  }

  // Remove if similar query exists and add to front
  recentQueries[filePath] = recentQueries[filePath].filter(q => q.query !== query);
  recentQueries[filePath].unshift(queryData);

  // Keep only 5 recent queries per file path
  if (recentQueries[filePath].length > 5) recentQueries[filePath].pop();
  localStorage.setItem("recentQueries", JSON.stringify(recentQueries));
}

function renderRecentQueries() {
  const recentQueriesEl = DOM.recentQueries();
  if (!recentQueriesEl) return;

  const filePath = DOM.filePathInput()?.value.trim() || "default";
  const currentFileQueries = recentQueries[filePath] || [];

  if (currentFileQueries.length === 0) {
    render(html``, recentQueriesEl);
    return;
  }

  const template = html`
    <div class="card mb-3">
      <div class="card-header d-flex justify-content-between align-items-center">
        <h5 class="mb-0">Recent Queries for ${filePath}</h5>
        <button
          class="btn btn-sm btn-outline-danger"
          @click=${() => {
            if (recentQueries[filePath]) {
              delete recentQueries[filePath];
              localStorage.setItem("recentQueries", JSON.stringify(recentQueries));
              renderRecentQueries();
            }
          }}
        >
          <i class="bi bi-x-circle"></i> Clear
        </button>
      </div>
      <div class="list-group list-group-flush">
        ${currentFileQueries.map(
          (item, index) => html`
            <div class="list-group-item">
              <div class="d-flex justify-content-between align-items-center">
                <strong class="query-text">${item.query}</strong>
                <div>
                  <button
                    class="btn btn-sm btn-outline-primary me-2"
                    @click=${() => {
                      const queryInput = DOM.queryInput();
                      if (queryInput) {
                        queryInput.value = item.query;
                        DOM.executeButton()?.click();
                      }
                    }}
                  >
                    <i class="bi bi-arrow-repeat"></i> Rerun
                  </button>
                  <button
                    class="btn btn-sm btn-outline-secondary"
                    @click=${() => toggleQueryDetails(filePath, index)}
                    id="toggle-btn-${filePath}-${index}"
                  >
                    <i class="bi bi-chevron-down" id="toggle-icon-${filePath}-${index}"></i>
                  </button>
                </div>
              </div>
              <div class="mt-2">
                <small class="text-muted">Run on: ${new Date(item.timestamp).toLocaleString()}</small>
                <div id="query-details-${filePath}-${index}" style="display: none;" class="mt-2">
                  ${item.result && item.result.length > 0
                    ? html`
                        <div class="card">
                          <div class="card-header py-1">
                            <small class="fw-bold">Results (first ${Math.min(3, item.result.length)} of ${item.result.length})</small>
                          </div>
                          <div class="card-body p-2">
                            <pre class="mb-0" style="font-size: 12px; max-height: 150px; overflow-y: auto;">${JSON.stringify(item.result, null, 2)}</pre>
                          </div>
                        </div>
                      `
                    : html`<div class="alert alert-warning py-1">No results available</div>`
                  }
                </div>
              </div>
            </div>
          `
        )}
      </div>
    </div>
  `;
  render(template, recentQueriesEl);

  // Add toggle functionality after rendering
  currentFileQueries.forEach((_, index) => {
    document.getElementById(`toggle-btn-${filePath}-${index}`)?.addEventListener('click', () => {
      toggleQueryDetails(filePath, index);
    });
  });
}

// Helper function to toggle query details visibility
function toggleQueryDetails(filePath, index) {
  const detailsEl = document.getElementById(`query-details-${filePath}-${index}`);
  const iconEl = document.getElementById(`toggle-icon-${filePath}-${index}`);

  if (detailsEl && iconEl) {
    if (detailsEl.style.display === "none") {
      detailsEl.style.display = "block";
      iconEl.classList.replace("bi-chevron-down", "bi-chevron-up");
    } else {
      detailsEl.style.display = "none";
      iconEl.classList.replace("bi-chevron-up", "bi-chevron-down");
    }
  }
}
