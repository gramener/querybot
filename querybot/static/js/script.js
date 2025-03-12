import { html, render } from "https://cdn.jsdelivr.net/npm/lit-html/lit-html.js";
import { unsafeHTML } from "https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";

const marked = new Marked();

const $openaiApiKey = document.getElementById("openai-api-key");
const $openaiApiBase = document.getElementById("openai-api-base");
const $toast = document.getElementById("toast");
const toast = new bootstrap.Toast($toast);

function notify(cls, title, message) {
  $toast.querySelector(".toast-title").textContent = title;
  $toast.querySelector(".toast-body").textContent = message;
  const $toastHeader = $toast.querySelector(".toast-header");
  $toastHeader.classList.remove("text-bg-success", "text-bg-danger", "text-bg-warning", "text-bg-info");
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
};

document.addEventListener("DOMContentLoaded", () => {
  const loadFileButton = document.getElementById("loadFileButton");
  const executeButton = DOM.executeButton();

  if (loadFileButton) {
    loadFileButton.addEventListener("click", loadFile);
  }
  if (executeButton) {
    executeButton.addEventListener("click", executeQuery);
  }
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
});

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
                  .filter(question => question.trim())
                  .map((question) => html` <a class="list-group-item suggested-question" href="#">${question}</a>`)}
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
  const errorTemplate = html`
    <div class="alert alert-danger" role="alert"><strong>Error:</strong> ${errorMessage}</div>
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

  if (!query) {
    renderError("Please enter a valid query.");
    return;
  }

  try {
    const response = await fetch("/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataset_name: "dataset",
        query,
        file_path: filePath,
        extract_sql: true, // Add this flag to indicate we want SQL extraction
      }),
    });

    const result = await response.json();
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

    const queryOutput = html`
      <div class="card">
        <div class="card-header">
          <h5>Query Result</h5>
        </div>
        <div class="card-body">
          <h6>Response from LLM:</h6>
          <div>${unsafeHTML(marked.parse(result.llm_response))}</div>
          <h6>SQL Query Execution Result:</h6>
          <div id="sqlResultTable" class="table-responsive" style="max-height: 50vh;"></div>
          <div class="mt-3">
            <button class="btn btn-primary me-2" @click=${() => downloadCSV(result.result, "query_result.csv")}>
              <i class="bi bi-download"></i> Download Results as CSV
            </button>
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
                <button class="btn btn-info" @click=${() => explainResults(result.result, query)}>
                  <i class="bi bi-lightbulb"></i> Explain Results
                </button>
              </div>
            </div>
          </div>
          <div id="explanationOutput" class="mt-3"></div>
        </div>
      </div>
    `;

    render(queryOutput, responseOutput);
    document.getElementById("sqlResultTable").innerHTML = generateTable(result.result);
  } catch (error) {
    renderError(error.message);
  }
}

// Add new explainResults function
async function explainResults(data, originalQuery) {
  const explanationOutput = document.getElementById("explanationOutput");
  const additionalPrompt = document.getElementById("additionalPrompt")?.value.trim();
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

    const response = await fetch("/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataset_name: "explanation",
        query: userMessage,
        file_path: DOM.filePathInput()?.value.trim() || "",
        system_prompt: systemPrompt,
        is_explanation: true,
      }),
    });

    if (!response.ok) throw new Error(`Error getting explanation: ${response.statusText}`);

    const result = await response.json();
    const explanationTemplate = html`
      <div class="card">
        <div class="card-header">
          <h6>Answer Analysis</h6>
        </div>
        <div class="card-body">
          <p class="fw-bold">Question: ${originalQuery}</p>
          ${additionalPrompt ? html`<p class="text-muted">Additional Instructions: ${additionalPrompt}</p>` : ""}
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
    const response = await fetch("/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_paths: filePath.split(/\s*,\s*/) }),
    });

    if (!response.ok) throw new Error(`Error loading file: ${response.statusText}`);

    const data = await response.json();
    renderOutput(data);
    DOM.executeButton()?.removeAttribute("disabled");
  } catch (error) {
    console.error(error);
    renderError(error.message);
  }
}

// Optimized table generation
function generateTable(data) {
  if (!Array.isArray(data) || !data.length) return "";

  const headers = Object.keys(data[0]);
  return `
        <table class="table table-bordered table-striped">
            <thead>
                <tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr>
            </thead>
            <tbody>
                ${data
                  .map((row) => `<tr>${headers.map((header) => `<td>${row[header] ?? ""}</td>`).join("")}</tr>`)
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
    ...data.map((row) => headers.map((header) => JSON.stringify(row[header] ?? "")).join(",")),
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
  const response = await fetch("/list-files");
  const data = await response.json();
  const fileList = document.getElementById("fileList");
  render(
    html`<ul class="list-group">
      ${data.files.map((file) => html`<li class="list-group-item">${file}</li>`).join("")}
    </ul>`,
    fileList
  );
}

document.getElementById("settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  document.querySelector("#settings .loading").classList.remove("d-none");
  let response;
  try {
    response = await fetch("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: $openaiApiKey.value, base: $openaiApiBase.value }),
    });
  } catch (e) {
    return notify("danger", "Could not save settings", e.message);
  } finally {
    document.querySelector("#settings .loading").classList.add("d-none");
  }
  if (!response.ok) return notify("danger", "Could not save settings", await response.text());
  localStorage.setItem("localDataChatOpenAIAPIKey", $openaiApiKey.value);
  localStorage.setItem("localDataChatOpenAIAPIBase", $openaiApiBase.value);
  document.querySelector("#settings .saved").classList.remove("d-none");
  setTimeout(() => {
    document.querySelector("#settings .saved").classList.add("d-none");
    document.querySelector("#settings").classList.remove("show");
  }, 2000);
});

document.querySelector("#openai-api-key").value = localStorage.getItem("localDataChatOpenAIAPIKey");
document.querySelector("#openai-api-base").value =
  localStorage.getItem("localDataChatOpenAIAPIBase") ?? "https://llmfoundry.straive.com/openai/v1";
if (!document.querySelector("#openai-api-key").value) document.querySelector("#settings").classList.add("show");
