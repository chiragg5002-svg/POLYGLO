async function fetchJson(url, options = {}) {
  const response = await window.maestroOperatorFetch(url, options);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Server returned an invalid response.");
  }
  if (!response.ok) {
    const error = new Error(data.message || data.error?.message || data.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

/* ================================
   HTML ESCAPING
   All server/user-derived strings must pass through this
   before being placed into innerHTML.
================================ */
function escapeHtml(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ================================
   SENSITIVE-DATA REDACTION
   Belt-and-suspenders client-side pass over any free-text message
   from the server (error text, import/query status messages) before
   it is ever escaped and rendered. The server already avoids putting
   credentials/connection strings into these fields, but a raw driver
   error message is outside our control, so nothing reaches the DOM
   without going through this first.
================================ */
function redactSensitive(value) {
  if (value === null || value === undefined) {
    return value;
  }
  return (
    String(value)
      // user:pass@host, with or without a protocol:// prefix
      .replace(
        /(\w+:\/\/)?[^\s/:@'"]+:[^\s/:@'"]+@/g,
        (match, protocol) => `${protocol || ""}[REDACTED]@`,
      )
      // key: value / key=value style secrets in stack traces or dumps
      .replace(
        /((?:password|pwd|passwd|secret|token|api[-_]?key)\s*[:=]\s*)([^\s,;'"]+)/gi,
        "$1[REDACTED]",
      )
  );
}

// Combines redaction + HTML-escaping for any free-text message pulled
// from a server response. Use this (not plain escapeHtml) for
// error/status messages; keep plain escapeHtml for structured,
// non-message fields (names, counts, types) that redaction wouldn't
// meaningfully apply to anyway.
function escapeMessage(value) {
  return escapeHtml(redactSensitive(value));
}

/* ================================
   ERROR CLASSIFICATION
   Maps a raw error/status message to one of a handful of clear,
   user-facing categories so the same underlying failure (a bad file,
   an unreachable database, an unreachable Ollama, a failed import, an
   invalid query) always reads the same way regardless of which
   endpoint produced it.
================================ */
function classifyError(rawMessage, status) {
  const message = rawMessage || "Something went wrong.";
  const lower = message.toLowerCase();
  if (status === 503 && /operator access is not configured/.test(lower)) {
    return {
      title: "Operator access is not configured",
      detail: "Set MAESTRO_ADMIN_TOKEN on the server, then enter it in the Developer Platform section.",
    };
  }
  if (status === 401 || /operator credentials required|authentication required/.test(lower)) {
    return {
      title: "Operator authentication required",
      detail: "Enter MAESTRO_ADMIN_TOKEN in the Developer Platform section and select Verify and sign in.",
    };
  }
  if (/operator access is not configured/.test(lower)) {
    return {
      title: "Operator access is not configured",
      detail: "Set MAESTRO_ADMIN_TOKEN on the server, then enter it in the Developer Platform section.",
    };
  }
  if (
    /only csv or json|unsupported file type|no data rows|file too large|json file must contain/.test(
      lower,
    )
  ) {
    return { title: "Invalid file", detail: message };
  }
  if (/ollama/.test(lower)) {
    return { title: "Ollama unavailable", detail: message };
  }
  if (
    /econnrefused|enotfound|etimedout|connect(ion)? (refused|timed out)|could not connect|no connection could be made|server selection|authentication failed/.test(
      lower,
    )
  ) {
    return { title: "Database unavailable", detail: message };
  }
  if (/import/.test(lower) && /(fail|error)/.test(lower)) {
    return { title: "Import failed", detail: message };
  }
  if (
    /querytype|query type|operator|conditions|sort direction|target database|dataset ".*" was not found|unknown column|cross-database joins|join\./i.test(
      message,
    )
  ) {
    return { title: "Invalid query", detail: message };
  }
  return { title: "Error", detail: message };
}

function showGlobalError(rawMessage, status) {
  const { title, detail } = classifyError(rawMessage, status);
  let banner = document.getElementById("global-error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "global-error-banner";
    banner.className = "error-banner";
    banner.setAttribute("role", "alert");
    document.body.prepend(banner);
  }
  banner.replaceChildren(document.createTextNode(`${title}: ${redactSensitive(detail)} `));
  if (title === "Operator authentication required" || title === "Operator access is not configured") {
    const link = document.createElement("a");
    link.href = "#platform-card";
    link.textContent = "Go to operator sign-in";
    banner.appendChild(link);
  }
  banner.style.display = "block";
}

function clearGlobalError() {
  const banner = document.getElementById("global-error-banner");
  if (banner) {
    banner.style.display = "none";
  }
}

/* ================================
   METADATA SUMMARY
================================ */
async function loadSummary() {
  const status = document.getElementById("summary-status");
  if (!window.maestroOperatorAuthenticated) {
    ["summary-databases", "summary-imports", "summary-created", "summary-failed", "summary-local", "summary-updated"]
      .forEach((id) => { document.getElementById(id).textContent = "Authenticate to load"; });
    status.textContent = "Authenticate in Developer Platform to load operator metrics.";
    return;
  }
  status.className = "status";
  status.textContent = "Loading operator metrics…";
  try {
    const summary = await fetchJson("/metadata/summary");
    document.getElementById("summary-databases").textContent =
      summary.totalDatabases ?? "Unavailable";
    document.getElementById("summary-imports").textContent =
      summary.totalImports ?? "Unavailable";
    document.getElementById("summary-created").textContent =
      summary.createdDatabases ?? "Unavailable";
    document.getElementById("summary-failed").textContent =
      summary.failedOperations ?? "Unavailable";
    document.getElementById("summary-local").textContent =
      summary.localPlacements ?? "Unavailable";
    document.getElementById("summary-updated").textContent = summary.lastUpdated
      ? new Date(summary.lastUpdated).toLocaleString()
      : "Unavailable";
    status.textContent = "";
  } catch (error) {
    status.className = "status error";
    status.textContent = `Could not load summary metrics: ${redactSensitive(error.message)}`;
    ["summary-databases", "summary-imports", "summary-created", "summary-failed", "summary-local", "summary-updated"]
      .forEach((id) => { document.getElementById(id).textContent = "Unavailable"; });
  }
}

/* ================================
   METADATA TABLE
================================ */
async function loadMetadata() {
  const tbody = document.getElementById("metadata-table-body");
  if (!window.maestroOperatorAuthenticated) {
    tbody.innerHTML = '<tr><td colspan="5">Authenticate in Developer Platform to load metadata activity.</td></tr>';
    document.getElementById("metadata-status").textContent = "";
    return;
  }
  document.getElementById("metadata-status").className = "status";
  document.getElementById("metadata-status").textContent = "Loading metadata activity…";
  try {
    const tableRows = await fetchJson("/metadata/table");
    if (!Array.isArray(tableRows)) {
      throw new Error("The metadata endpoint returned an invalid response.");
    }
    tbody.innerHTML = "";
    if (!tableRows.length) {
      tbody.innerHTML =
        '<tr><td colspan="5">No metadata yet. Create a database or import a file.</td></tr>';
      document.getElementById("metadata-status").textContent = "";
      return;
    }
    tableRows.forEach((row) => {
      const tr = document.createElement("tr");
      const status = row.status || "pending";
      tr.innerHTML = `
        <td>${escapeHtml(row.type || "n/a")}</td>
        <td>${escapeHtml(row.name || "unknown")}</td>
        <td>${escapeHtml(row.target || "n/a")}</td>
        <td>
          <span class="badge ${escapeHtml(status)}">
            ${escapeHtml(status)}
          </span>
        </td>
        <td>
          ${escapeMessage(row.message || "—")}
          <br>
          <small>${escapeHtml(row.timestamp || "n/a")}</small>
        </td>
      `;
      tbody.appendChild(tr);
    });
    document.getElementById("metadata-status").textContent = "";
  } catch (error) {
    tbody.innerHTML = '<tr><td colspan="5">Metadata activity is unavailable.</td></tr>';
    const status = document.getElementById("metadata-status");
    status.className = "status error";
    status.textContent = `Could not load metadata activity: ${redactSensitive(error.message)}`;
  }
}

/* ================================
   CONNECTION STATUS
================================ */
async function renderConnectionStatus() {
  const statusMessage = document.getElementById("connection-status-message");
  try {
    const statusContainer = document.getElementById("connection-status-list");
    statusMessage.textContent = "Checking service readiness…";
    const response = await window.fetch("/ready");
    let health;
    try {
      health = await response.json();
    } catch {
      throw new Error("The readiness endpoint returned an invalid response.");
    }
    if (!response.ok && !health.dependencies) {
      throw new Error(`Readiness check failed (HTTP ${response.status}).`);
    }
    statusContainer.innerHTML = "";
    Object.entries(health.dependencies || {}).forEach(([name, state]) => {
      const badge = document.createElement("span");
      const normalized = state === "ok" ? "success" : "error";
      badge.className = `badge ${normalized}`;
      badge.textContent = `${name}: ${state}`;
      statusContainer.appendChild(badge);
    });
    statusMessage.textContent = health.ready
      ? `API readiness: ${health.status || "ok"}. Dependency states are reported by the server.`
      : `API readiness: ${health.status || "unavailable"}. One or more required services may be unavailable.`;
  } catch (error) {
    statusMessage.textContent = `Service readiness unavailable: ${redactSensitive(error.message)}`;
  }
}

/* ================================
   DATASET PROFILING
================================ */
// Tracks the most recent profiling request so that a stale, slower
// response can't overwrite a newer one if the user swaps files quickly.
let activeProfileToken = 0;

async function profileDataset(file) {
  if (!file) {
    return null;
  }
  if (!window.maestroOperatorAuthenticated) {
    throw new Error("Authenticate in Developer Platform before requesting dataset analysis.");
  }
  const token = ++activeProfileToken;
  const formData = new FormData();
  formData.append("datasetFile", file);
  const result = await fetchJson("/profile", {
    method: "POST",
    body: formData,
  });
  if (!result.success || !result.profile) {
    throw new Error(result.message || "Dataset profiling failed.");
  }
  // If a newer file was selected while this request was in flight,
  // drop this result instead of rendering stale data.
  if (token !== activeProfileToken) {
    return null;
  }
  renderProfile(result.profile);
  return result.profile;
}

/* ================================
   RENDER DATASET PROFILE
================================ */
function renderProfile(profile) {
  const card = document.getElementById("routing-card");
  if (!card) {
    return;
  }
  let html = `
    <h2>Dataset Profile</h2>
    <div class="grid">
      <div class="card">
        <h3>Dataset</h3>
        <p>${escapeHtml(profile.dataset)}</p>
      </div>
      <div class="card">
        <h3>Rows</h3>
        <p>${escapeHtml(profile.rowCount)}</p>
      </div>
      <div class="card">
        <h3>Columns</h3>
        <p>${escapeHtml(profile.columnCount)}</p>
      </div>
    </div>
    <h3>Column Analysis</h3>
    <table>
      <thead>
        <tr>
          <th>Column</th>
          <th>Type</th>
          <th>Missing</th>
          <th>Unique</th>
          <th>Quality</th>
          <th>Pattern</th>
          <th>Statistics</th>
        </tr>
      </thead>
      <tbody>
  `;
  profile.columns.forEach((column) => {
    let statistics = "—";
    if (column.type === "Numeric") {
      statistics = `
        Min: ${escapeHtml(column.min)}<br>
        Max: ${escapeHtml(column.max)}<br>
        Avg: ${escapeHtml(column.average)}<br>
        Median: ${escapeHtml(column.median)}<br>
        Std Dev: ${escapeHtml(column.stdDev)}
      `;
    } else if (column.type === "Date") {
      statistics = `
        From: ${escapeHtml(column.earliestDate)}<br>
        To: ${escapeHtml(column.latestDate)}<br>
        Span: ${escapeHtml(column.timeSpanDays)} days
      `;
    } else if (column.type === "Boolean") {
      statistics = `
        True: ${escapeHtml(column.trueCount)}<br>
        False: ${escapeHtml(column.falseCount)}<br>
        True %: ${escapeHtml(column.truePercentage)}%
      `;
    }
    html += `
      <tr>
        <td>
          <strong>${escapeHtml(column.column)}</strong>
        </td>
        <td>
          ${escapeHtml(column.type)}
        </td>
        <td>
          ${escapeHtml(column.missingCount)}
          (${escapeHtml(column.missingPercentage)}%)
        </td>
        <td>
          ${escapeHtml(column.uniqueValues)}
        </td>
        <td>
          <span class="badge ${escapeHtml(getQualityClass(column.quality))}">
            ${escapeHtml(column.quality)}
          </span>
        </td>
        <td>
          ${escapeHtml(column.pattern || "—")}
        </td>
        <td>
          ${statistics}
        </td>
      </tr>
    `;
  });
  html += `
      </tbody>
    </table>
    <br>
    <div id="routing-recommendation">
      <h3>Database Routing</h3>
      <p>
        Dataset profiling completed successfully.
        Database recommendation will be generated next.
      </p>
    </div>
  `;
  card.innerHTML = html;
}

/* ================================
   QUALITY BADGE
================================ */
function getQualityClass(quality) {
  if (!quality) {
    return "pending";
  }
  const value = quality.toLowerCase();
  if (value === "excellent" || value === "good") {
    return "imported";
  }
  if (value === "fair") {
    return "pending";
  }
  if (value === "poor") {
    return "error";
  }
  return "pending";
}

/* ================================
   LLM / ROUTING RECOMMENDATION
================================ */
// Tracks the most recent routing request for the same reason as
// activeProfileToken above.
let activeRoutingToken = 0;

async function requestRoutingRecommendation(file) {
  if (!file) {
    return;
  }
  if (!window.maestroOperatorAuthenticated) {
    throw new Error("Authenticate in Developer Platform before requesting database routing.");
  }
  const token = ++activeRoutingToken;
  try {
    const text = await file.text();
    let payload;
    try {
      const parsed = JSON.parse(text);
      payload = {
        rows: Array.isArray(parsed) ? parsed : [parsed],
        originalName: file.name,
      };
    } catch {
      const lines = text
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.trim());
      if (lines.length === 0) {
        throw new Error("CSV file is empty.");
      }
      const delimiter = lines[0].includes("\t") ? "\t" : ",";
      const headers = lines[0].split(delimiter).map((header) => header.trim());
      const rows = lines.slice(1).map((line) => {
        const values = line.split(delimiter);
        const row = {};
        headers.forEach((header, index) => {
          row[header] =
            values[index] !== undefined ? values[index].trim() : null;
        });
        return row;
      });
      payload = {
        originalName: file.name,
        rows,
      };
    }
    const recommendation = await fetchJson("/routing/recommend", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (token !== activeRoutingToken) {
      // A newer file was selected while this request was pending.
      return;
    }
    const recommendationBox = document.getElementById("routing-recommendation");
    if (!recommendationBox) {
      return;
    }
    const isOllamaUnavailable =
      recommendation.source === "fallback" &&
      /ollama is unavailable/i.test(recommendation.reason || "");
    recommendationBox.innerHTML = `
      <h3>Database Routing Recommendation</h3>
      ${
        isOllamaUnavailable
          ? `<div class="warning-banner">Ollama unavailable — showing the rule-based recommendation instead.</div>`
          : ""
      }
      <p>
        <strong>Recommended Database:</strong>
        ${escapeHtml(recommendation.target || "Not available")}
      </p>
      <p>
        <strong>Confidence:</strong>
        ${escapeHtml(recommendation.confidence || "Not available")}
      </p>
      <p>
        <strong>Reason:</strong>
        ${escapeMessage(recommendation.reason || "No reason provided")}
      </p>
      <p>
        <strong>Source:</strong>
        ${escapeHtml(recommendation.source || "Rule-based")}
      </p>
    `;
  } catch (error) {
    console.error("Routing recommendation error:", error);
    const recommendationBox = document.getElementById("routing-recommendation");
    if (recommendationBox && token === activeRoutingToken) {
      const { title, detail } = classifyError(error.message);
      recommendationBox.innerHTML = `
        <h3>Database Routing Recommendation</h3>
        <p class="error">${escapeHtml(title)}: ${escapeMessage(detail)}</p>
      `;
    }
  }
}

/* ================================
   AUTOMATIC DATA PARTITIONING PREVIEW
================================ */
const TARGET_LABELS = {
  postgres: "PostgreSQL",
  mongodb: "MongoDB",
  elasticsearch: "Elasticsearch",
};

// Tracks the most recent partition-preview request for the same
// reason as activeProfileToken/activeRoutingToken above.
let activePartitionToken = 0;

async function requestPartitionPreview(file) {
  if (!file) {
    return;
  }
  const token = ++activePartitionToken;
  const card = document.getElementById("partition-card");
  try {
    const formData = new FormData();
    formData.append("datasetFile", file);
    const result = await fetchJson("/partition/preview", {
      method: "POST",
      body: formData,
    });
    if (token !== activePartitionToken || !card) {
      return;
    }
    if (!result.success || !result.plan) {
      throw new Error(result.message || "Partition preview failed.");
    }
    renderPartitionPlan(result.plan);
  } catch (error) {
    console.error("Partition preview error:", error);
    if (card && token === activePartitionToken) {
      const { title, detail } = classifyError(error.message);
      card.innerHTML = `<h2>Partition Preview</h2><p class="error">${escapeHtml(title)}: ${escapeMessage(detail)}</p>`;
    }
  }
}

function renderPartitionPlan(plan) {
  const card = document.getElementById("partition-card");
  if (!card) return;
  let html = `<h2>Partition Preview</h2>`;
  html += `<p><strong>${plan.required ? "Partitioning required" : "No partitioning needed"}:</strong> ${escapeHtml(plan.reason)}</p>`;
  if (plan.recordIdentifier) {
    html += `<p class="note">Record identifier: <strong>${escapeHtml(plan.recordIdentifier.column)}</strong>${plan.recordIdentifier.synthesized ? " (synthesized from row position)" : ""} — ${escapeHtml(plan.recordIdentifier.reason)}</p>`;
  }
  if (plan.warnings && plan.warnings.length) {
    html += `<ul>${plan.warnings.map((warning) => `<li class="note">${escapeHtml(warning)}</li>`).join("")}</ul>`;
  }
  (plan.partitions || []).forEach((partition) => {
    html += `
      <div class="card">
        <h3>${escapeHtml(TARGET_LABELS[partition.target] || partition.target)}
          <span class="badge imported">${escapeHtml(partition.recordCount)} record(s)</span>
        </h3>
        <p class="note">${escapeHtml(partition.reason)}</p>
        <p class="note">Columns: ${partition.columns.map((c) => escapeHtml(c)).join(", ")}</p>
        ${renderSampleTable(partition.sampleRecords)}
      </div>
    `;
  });
  if (plan.relationshipInformation) {
    html += `<p class="note">${escapeHtml(plan.relationshipInformation)}</p>`;
  }
  card.innerHTML = html;
}

function renderSampleTable(sampleRecords) {
  if (!sampleRecords || !sampleRecords.length) {
    return `<p class="note">No sample rows available.</p>`;
  }
  const columns = Object.keys(sampleRecords[0]);
  let html = `<table><thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>`;
  sampleRecords.forEach((record) => {
    html += `<tr>${columns
      .map((c) => {
        const value = record[c];
        const display =
          value !== null && typeof value === "object"
            ? JSON.stringify(value)
            : value;
        return `<td>${escapeHtml(display)}</td>`;
      })
      .join("")}</tr>`;
  });
  html += `</tbody></table>`;
  return html;
}

/* ================================
   METADATA RELATION & HYBRID STORE ANALYSIS
   Calls POST /analysis/store (data-profiler + relationship analysis
   + rule-based scoring + optional Ollama scoring + weighted hybrid
   decision — see store-analysis-engine.js) and renders the result.
   Purely additive: does not touch the existing routing/partition
   preview flow above.
================================ */
const STORE_ANALYSIS_LABELS = {
  postgresql: "PostgreSQL",
  mongodb: "MongoDB",
  elasticsearch: "Elasticsearch",
};

let activeStoreAnalysisToken = 0;

async function requestStoreAnalysis(file) {
  if (!file) {
    return;
  }
  const token = ++activeStoreAnalysisToken;
  const card = document.getElementById("store-analysis-card");
  try {
    const formData = new FormData();
    formData.append("datasetFile", file);
    const result = await fetchJson("/analysis/store", {
      method: "POST",
      body: formData,
    });
    if (token !== activeStoreAnalysisToken || !card) {
      return;
    }
    if (!result.success) {
      throw new Error(result.message || "Store analysis failed.");
    }
    renderStoreAnalysis(result);
  } catch (error) {
    console.error("Store analysis error:", error);
    if (card && token === activeStoreAnalysisToken) {
      const { title, detail } = classifyError(error.message);
      card.innerHTML = `<h2>Metadata Relation & Store Analysis</h2><p class="error">${escapeHtml(title)}: ${escapeMessage(detail)}</p>`;
    }
  }
}

function renderScoreRow(store, ruleBased, ollama, hybrid) {
  const ruleScore = ruleBased[store] ? ruleBased[store].score : 0;
  const ollamaScore =
    ollama && ollama.available && ollama.scores ? ollama.scores[store] : null;
  const hybridScore = hybrid.scores ? hybrid.scores[store] : 0;
  const isRecommended = hybrid.recommendation === store;
  return `
    <tr${isRecommended ? ' class="badge success"' : ""}>
      <td>${escapeHtml(STORE_ANALYSIS_LABELS[store] || store)}${isRecommended ? " ⭐" : ""}</td>
      <td>${escapeHtml(ruleScore)}</td>
      <td>${ollamaScore === null ? "n/a" : escapeHtml(ollamaScore)}</td>
      <td>${escapeHtml(hybridScore)}</td>
    </tr>
  `;
}

function renderStoreAnalysis(result) {
  const card = document.getElementById("store-analysis-card");
  if (!card) return;
  const { metadata, relationships, ruleBased, ollama, hybrid, warnings } =
    result;
  const isOllamaUnavailable = !ollama || !ollama.available;
  let html = `<h2>Metadata Relation & Store Analysis</h2>`;
  if (isOllamaUnavailable) {
    html += `<div class="warning-banner">Ollama unavailable — using rule-based fallback.</div>`;
  } else if (hybrid.agreement === false) {
    html += `<div class="warning-banner">Rule-based and Ollama disagree — see the weighted hybrid score below.</div>`;
  }
  html += `<h3>Dataset Information</h3>`;
  html += `
    <div class="result-summary">
      <div class="stat"><span>Rows</span><strong>${escapeHtml(metadata.rowCount)}</strong></div>
      <div class="stat"><span>Fields</span><strong>${escapeHtml(metadata.fieldCount)}</strong></div>
      <div class="stat"><span>Nulls (avg field)</span><strong>${escapeHtml(
        metadata.fieldCount
          ? (
              Object.values(metadata.nullPercentage || {}).reduce(
                (sum, value) => sum + (value || 0),
                0,
              ) / metadata.fieldCount
            ).toFixed(2)
          : 0,
      )}%</strong></div>
      <div class="stat"><span>Nested Depth</span><strong>${escapeHtml(metadata.nestedDepth)}</strong></div>
      <div class="stat"><span>Text Density</span><strong>${escapeHtml(metadata.textDensity)}</strong></div>
    </div>
  `;
  html += `<p class="note">Numeric: ${metadata.numericFields.length} · Categorical: ${metadata.categoricalFields.length} · Text: ${metadata.textFields.length} · Date: ${metadata.dateFields.length} · Arrays: ${metadata.arrays.length} · Objects: ${metadata.objects.length}</p>`;
  html += `<h3>Relationship Analysis</h3>`;
  if (!relationships.relations || !relationships.relations.length) {
    html += `<p class="note">No primary-key, foreign-key, or grouping relationships were confidently detected.</p>`;
  } else {
    html += `<ul>${relationships.relations
      .map(
        (relation) =>
          `<li><strong>${escapeHtml(relation.type)}</strong> — ${escapeMessage(relation.reason)} (confidence ${escapeHtml(relation.confidence)})</li>`,
      )
      .join("")}</ul>`;
  }
  html += `<p class="note">Overall relationship confidence: ${escapeHtml(relationships.confidence)}</p>`;
  html += `<h3>Store Analysis</h3>`;
  html += `
    <table>
      <thead><tr><th>Store</th><th>Rule-Based Score</th><th>Ollama Score</th><th>Hybrid Score</th></tr></thead>
      <tbody>
        ${["postgresql", "mongodb", "elasticsearch"]
          .map((store) => renderScoreRow(store, ruleBased, ollama, hybrid))
          .join("")}
      </tbody>
    </table>
  `;
  html += `
    <h3>Final Recommendation</h3>
    <p><strong>Recommended Store:</strong> ${escapeHtml(STORE_ANALYSIS_LABELS[hybrid.recommendation] || hybrid.recommendation)}</p>
    <p><strong>Confidence:</strong> ${escapeHtml(hybrid.confidence)}</p>
    <p><strong>Rule/Ollama Agreement:</strong> ${hybrid.agreement ? "Yes" : "No"}${
      !isOllamaUnavailable
        ? ` (rule-based: ${escapeHtml(STORE_ANALYSIS_LABELS[hybrid.ruleBasedRecommendation] || hybrid.ruleBasedRecommendation)}, Ollama: ${escapeHtml(
            STORE_ANALYSIS_LABELS[hybrid.ollamaRecommendation] ||
              hybrid.ollamaRecommendation,
          )})`
        : ""
    }</p>
  `;
  if (hybrid.reasons && hybrid.reasons.length) {
    html += `<p><strong>Reasoning:</strong></p><ul>${hybrid.reasons.map((reason) => `<li>${escapeMessage(reason)}</li>`).join("")}</ul>`;
  }
  if (warnings && warnings.length) {
    html += `<ul>${warnings.map((warning) => `<li class="note">${escapeMessage(warning)}</li>`).join("")}</ul>`;
  }
  card.innerHTML = html;
}

/* ================================
   CLIENT-SIDE FILE VALIDATION
   Mirrors the server's own checks (extension, non-empty, size limit)
   so an obviously-bad file is rejected instantly instead of round-
   tripping to /profile just to get the same error back.
================================ */
const ALLOWED_DATASET_EXTENSIONS = [".csv", ".json"];
const MAX_CLIENT_FILE_BYTES = 25 * 1024 * 1024; // kept in sync with server.js's MAX_UPLOAD_BYTES

function validateDatasetFile(file) {
  if (!file) {
    return { valid: false, message: "Choose a CSV or JSON file first." };
  }
  const name = file.name || "";
  const hasAllowedExtension = ALLOWED_DATASET_EXTENSIONS.some((ext) =>
    name.toLowerCase().endsWith(ext),
  );
  if (!hasAllowedExtension) {
    return { valid: false, message: `"${name}" is not a .csv or .json file.` };
  }
  if (file.size === 0) {
    return { valid: false, message: `"${name}" is empty.` };
  }
  if (file.size > MAX_CLIENT_FILE_BYTES) {
    return {
      valid: false,
      message: `"${name}" is larger than ${MAX_CLIENT_FILE_BYTES / (1024 * 1024)}MB.`,
    };
  }
  return { valid: true, message: "" };
}

/* ================================
   FILE PREVIEW HELPER
   Consolidates the "profile + recommend + partition" pipeline so it
   only ever runs once per file selection, whether triggered by
   drag/drop, the file input's change event, or form submission.
================================ */
async function runFilePreview(file) {
  if (!file) {
    return;
  }
  const validation = validateDatasetFile(file);
  const fileErrorBox = document.getElementById("datasetFile-error");
  if (fileErrorBox) {
    fileErrorBox.textContent = validation.valid ? "" : validation.message;
  }
  if (!validation.valid) {
    // Don't even attempt to profile/route/partition a file we already
    // know the server will reject — requirement: frontend validation.
    const routingCard = document.getElementById("routing-card");
    const partitionCard = document.getElementById("partition-card");
    const storeAnalysisCard = document.getElementById("store-analysis-card");
    if (routingCard) {
      routingCard.innerHTML = `<h2>Dataset Profile</h2><p class="error">Invalid file: ${escapeHtml(validation.message)}</p>`;
    }
    if (partitionCard) {
      partitionCard.innerHTML = `<h2>Partition Preview</h2><p class="note">Fix the file selection above to see a partition preview.</p>`;
    }
    if (storeAnalysisCard) {
      storeAnalysisCard.innerHTML = `<h2>Metadata Relation & Store Analysis</h2><p class="note">Fix the file selection above to see the store analysis.</p>`;
    }
    return;
  }
  if (!window.maestroOperatorAuthenticated) {
    ["routing-card", "partition-card", "store-analysis-card"].forEach((id) => {
      const card = document.getElementById(id);
      if (card) card.innerHTML = `<h2>${id === "routing-card" ? "Dataset Analysis" : id === "partition-card" ? "Partition Preview" : "Metadata Relation & Store Analysis"}</h2><p class="note">Verify operator credentials in Developer Platform before requesting server-side analysis.</p>`;
    });
    return;
  }
  // Immediate loading state — otherwise the routing/partition/store
  // analysis cards sit on stale (or placeholder) content for the
  // whole round trip.
  const routingCard = document.getElementById("routing-card");
  const partitionCard = document.getElementById("partition-card");
  const storeAnalysisCard = document.getElementById("store-analysis-card");
  if (routingCard) {
    routingCard.innerHTML = `<h2>Dataset Profile</h2><p class="loading-text"><span class="spinner"></span>Profiling ${escapeHtml(file.name)}…</p>`;
  }
  if (partitionCard) {
    partitionCard.innerHTML = `<h2>Partition Preview</h2><p class="loading-text"><span class="spinner"></span>Checking whether this dataset needs to be split…</p>`;
  }
  if (storeAnalysisCard) {
    storeAnalysisCard.innerHTML = `<h2>Metadata Relation & Store Analysis</h2><p class="loading-text"><span class="spinner"></span>Analyzing metadata, relationships, and store fit…</p>`;
  }
  try {
    await profileDataset(file);
    await requestRoutingRecommendation(file);
    await requestPartitionPreview(file);
    await requestStoreAnalysis(file);
  } catch (error) {
    console.error("Profile error:", error);
    const card = document.getElementById("routing-card");
    if (card) {
      const { title, detail } = classifyError(error.message);
      card.innerHTML = `<h2>Dataset Profile</h2><p class="error">${escapeHtml(title)}: ${escapeMessage(detail)}</p>`;
    }
  }
}

/* ================================
   IMPORT PROGRESS + FINAL STATUS
================================ */
// There's no server-sent progress channel — /database/import is one
// synchronous request — so this shows an honest two-phase state
// (in progress / finished) rather than fabricating steps we can't
// actually observe, then renders the structured final status:
// records imported, failed records, selected database, and the
// table/collection/index name.
function renderImportProgress(container, phase, record, errorMessage) {
  if (!container) return;
  const steps = [
    {
      key: "in-progress",
      label: "Uploading file & writing rows to the target database",
    },
    { key: "done", label: "Import complete" },
  ];
  function stepClass(key) {
    if (phase === "uploading") return key === "in-progress" ? "active" : "";
    if (phase === "failed") return key === "in-progress" ? "failed" : "";
    return "done"; // phase === "done"
  }
  let html = `<ul class="progress-steps">${steps
    .map(
      (step) =>
        `<li class="${stepClass(step.key)}">${escapeHtml(step.label)}</li>`,
    )
    .join("")}</ul>`;
  if (phase === "failed" && errorMessage) {
    const { title, detail } = classifyError(errorMessage);
    html += `<p class="error">${escapeHtml(title)}: ${escapeMessage(detail)}</p>`;
  }
  if (phase === "done" && record) {
    const statusClass = record.status || "pending";
    html += `
      <div class="result-summary">
        <div class="stat"><span>Status</span><strong><span class="badge ${escapeHtml(statusClass)}">${escapeHtml(statusClass)}</span></strong></div>
        <div class="stat"><span>Records imported</span><strong>${escapeHtml(record.insertedCount ?? "—")}</strong></div>
        <div class="stat"><span>Failed records</span><strong>${escapeHtml(record.failedCount ?? 0)}</strong></div>
        <div class="stat"><span>Selected database</span><strong>${escapeHtml(record.dbType || "—")}</strong></div>
        <div class="stat"><span>Table / collection / index</span><strong>${escapeHtml(record.collectionName || "—")}</strong></div>
        <div class="stat"><span>Rows in file</span><strong>${escapeHtml(record.rowCount ?? "—")}</strong></div>
      </div>
      ${record.message ? `<p class="note">${escapeMessage(record.message)}</p>` : ""}
      ${
        Array.isArray(record.errors) && record.errors.length
          ? `<ul>${record.errors.map((e) => `<li class="error">${escapeMessage(e)}</li>`).join("")}</ul>`
          : ""
      }
    `;
  }
  container.innerHTML = html;
}

/* ================================
   FORM SUBMISSION
================================ */
async function handleSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (form.getAttribute("data-kind") === "query") {
    return handleQuerySubmit(event);
  }
  if (!window.maestroOperatorAuthenticated) {
    const status = form.querySelector(".status");
    status.className = "status error";
    status.textContent = "Operator authentication required. Verify MAESTRO_ADMIN_TOKEN in Developer Platform first.";
    return;
  }
  const isImportForm = form.dataset.kind === "import";
  const formData = new FormData(form);
  const isCreateDatabaseForm = form.action.endsWith("/database/create");
  const button = form.querySelector("button");
  const status = form.querySelector(".status");
  const progressBox = isImportForm
    ? document.getElementById("import-progress")
    : null;
  if (isImportForm) {
    const file = form.querySelector('input[type="file"]')?.files?.[0];
    const validation = validateDatasetFile(file);
    const fileErrorBox = document.getElementById("datasetFile-error");
    if (fileErrorBox) {
      fileErrorBox.textContent = validation.valid ? "" : validation.message;
    }
    if (!validation.valid) {
      // Frontend validation: don't even send an upload we already
      // know the server will reject.
      return;
    }
  }
  button.disabled = true;
  status.className = "status";
  status.innerHTML = `<span class="spinner"></span>Working…`;
  if (progressBox) {
    renderImportProgress(progressBox, "uploading");
  }
  try {
    let response;
    if (isCreateDatabaseForm) {
      const body = new URLSearchParams();
      for (const [key, value] of formData.entries()) {
        body.append(key, value);
      }
      response = await window.maestroOperatorFetch(form.action, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } else {
      response = await window.maestroOperatorFetch(form.action, {
        method: "POST",
        body: formData,
      });
    }

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.message || "Request failed");
    }
    status.textContent = "";
    if (progressBox) {
      renderImportProgress(progressBox, "done", data.data);
    } else {
      status.textContent = data.message;
    }
    // Note: for import forms, the dropzone/change handlers already
    // ran profileDataset + requestRoutingRecommendation the moment the
    // file was selected. We do NOT repeat that work here — doing so
    // previously caused every import to profile the file twice and
    // hit /routing/recommend twice.
    form.reset();
    const dropLabel = document.getElementById("drop-label");
    if (dropLabel) {
      dropLabel.textContent = "Drop a CSV or JSON file here";
    }
    clearGlobalError();
    await Promise.allSettled([loadSummary(), loadMetadata()]);
  } catch (error) {
    console.error(error);
    const { title, detail } = classifyError(error.message);
    status.className = "status error";
    status.textContent = `${title}: ${redactSensitive(detail)}`;
    if (progressBox) {
      renderImportProgress(progressBox, "failed", null, error.message);
    }
  } finally {
    button.disabled = false;
  }
}

/* ================================
   QUERY INTERFACE (/v1/query)
================================ */
function clearFieldErrors(ids) {
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  });
}

function renderQueryResults(data) {
  const box = document.getElementById("query-results");
  if (!box) return;
  const sourceBadge = `<span class="badge ${escapeHtml(data.source || "database")}">${escapeHtml(data.source || "database")}</span>`;
  if (data.status === "error") {
    const { title, detail } = classifyError(
      (data.error && data.error.message) || "Query failed.",
    );
    box.innerHTML = `
      <div class="result-summary">
        <div class="stat"><span>Selected database</span><strong>${escapeHtml(data.selectedDatabase || "—")}</strong></div>
        <div class="stat"><span>Source</span><strong>${sourceBadge}</strong></div>
      </div>
      <p class="error">${escapeHtml(title)}: ${escapeMessage(detail)}</p>
    `;
    return;
  }
  const results = Array.isArray(data.results) ? data.results : [];
  const isCount = data.queryPlan && data.queryPlan.queryType === "count";
  let html = `
    <div class="result-summary">
      <div class="stat"><span>Selected database</span><strong>${escapeHtml(data.selectedDatabase || "—")}</strong></div>
      <div class="stat"><span>Source</span><strong>${sourceBadge}</strong></div>
      <div class="stat"><span>${isCount ? "Matching count" : "Result count"}</span><strong>${escapeHtml(data.resultCount ?? results.length)}</strong></div>
    </div>
  `;
  if (isCount) {
    // count queries return no rows by design — the number above is the answer.
  } else if (results.length) {
    html += `<div class="query-results-table">${renderSampleTable(results)}</div>`;
  } else {
    html += `<p class="note">No matching rows/documents.</p>`;
  }
  if (data.queryPlan) {
    const planText = redactSensitive(JSON.stringify(data.queryPlan, null, 2));
    html += `
      <details class="query-plan">
        <summary>Query plan</summary>
        <pre>${escapeHtml(planText)}</pre>
      </details>
    `;
  }
  box.innerHTML = html;
}

async function handleQuerySubmit(event) {
  event.preventDefault();
  const button = document.getElementById("query-submit");
  const status = document.getElementById("query-status");
  const resultsBox = document.getElementById("query-results");
  if (!window.maestroOperatorAuthenticated) {
    status.className = "status error";
    status.textContent = "Operator authentication required. Verify MAESTRO_ADMIN_TOKEN in Developer Platform first.";
    return;
  }
  clearFieldErrors([
    "queryDataset-error",
    "queryConditions-error",
    "queryLimit-error",
  ]);

  const dataset = document.getElementById("queryDataset").value.trim();
  const queryType = document.getElementById("queryType").value;
  const targetDatabase = document.getElementById("queryTargetDatabase").value;
  const conditionsRaw = document.getElementById("queryConditions").value.trim();
  const sortField = document.getElementById("querySortField").value.trim();
  const sortDirection = document.getElementById("querySortDirection").value;
  const limitRaw = document.getElementById("queryLimit").value.trim();

  let hasError = false;

  // Frontend validation — catch obviously-bad input before it ever
  // reaches the network, with the same clarity the server itself uses.
  if (!dataset) {
    document.getElementById("queryDataset-error").textContent =
      "Dataset name is required.";
    hasError = true;
  }

  let conditions;
  if (conditionsRaw) {
    try {
      conditions = JSON.parse(conditionsRaw);
      if (
        typeof conditions !== "object" ||
        conditions === null ||
        Array.isArray(conditions)
      ) {
        throw new Error('must be a JSON object, e.g. {"status": "active"}');
      }
    } catch (parseError) {
      document.getElementById("queryConditions-error").textContent =
        `Invalid JSON: ${parseError.message}`;
      hasError = true;
    }
  }

  let limit;
  if (limitRaw) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      document.getElementById("queryLimit-error").textContent =
        "Limit must be a whole number between 1 and 500.";
      hasError = true;
    }
  }

  if (hasError) {
    return;
  }

  const body = { dataset, queryType };
  if (targetDatabase) body.targetDatabase = targetDatabase;
  if (conditions) body.conditions = conditions;
  if (queryType !== "count" && sortField) {
    body.sort = { field: sortField, direction: sortDirection || "asc" };
  }
  if (queryType !== "count" && limit) {
    body.limit = limit;
  }

  button.disabled = true;
  status.className = "status";
  status.innerHTML = `<span class="spinner"></span>Running query…`;
  resultsBox.innerHTML = "";

  try {
    const response = await window.maestroOperatorFetch("/v1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // Improved error handling: read as text first so we can show a useful message
    // when the server returns HTML (404 page, SPA fallback, etc.) instead of JSON.
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const preview = text.slice(0, 150).replace(/\s+/g, " ").trim();
      throw new Error(
        `Server returned an invalid response (HTTP ${response.status}). ` +
          `Expected JSON but received: ${preview}${text.length > 150 ? "…" : ""}`,
      );
    }

    if (!response.ok) {
      const error = new Error(data.message || data.error?.message || data.error || "Query failed.");
      error.status = response.status;
      throw error;
    }

    status.textContent = "";
    renderQueryResults(data);
  } catch (error) {
    console.error("Query error:", error);
    const { title, detail } = classifyError(error.message, error.status);
    status.className = "status error";
    status.textContent = `${title}: ${redactSensitive(detail)}`;
  } finally {
    button.disabled = false;
  }
}

/* ================================
   INITIALIZATION
================================ */
document.addEventListener("DOMContentLoaded", () => {
  /* Forms */
  document.querySelectorAll("form").forEach((form) => {
    // The query form posts a JSON body (not multipart/plain form
    // fields) and renders into its own results panel, so it gets its
    // own handler instead of the generic multipart-upload one.
    if (form.dataset.kind === "query") {
      form.addEventListener("submit", handleQuerySubmit);
      return;
    }
    form.addEventListener("submit", handleSubmit);
  });

  /* Dropzone */
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("datasetFile");
  const dropLabel = document.getElementById("drop-label");
  if (dropzone && fileInput) {
    ["dragenter", "dragover"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.remove("dragover");
      });
    });
    dropzone.addEventListener("drop", (event) => {
      const droppedFile = event.dataTransfer.files[0];
      if (droppedFile) {
        fileInput.files = event.dataTransfer.files;
        dropLabel.textContent = droppedFile.name;
        runFilePreview(droppedFile);
      }
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      dropLabel.textContent = file ? file.name : "Drop a CSV or JSON file here";
      if (file) {
        runFilePreview(file);
      }
    });
  }

  /* Readiness is public; the remaining dashboard data is operator-only. */
  window.maestroOperatorAuthenticated = false;
  renderConnectionStatus();
  loadSummary();
  loadMetadata();

  window.addEventListener("maestro:operator-auth-changed", () => {
    clearGlobalError();
    if (!window.maestroOperatorAuthenticated) {
      document.getElementById("query-results").replaceChildren();
      document.getElementById("query-status").textContent = "";
      document.getElementById("import-progress").replaceChildren();
      document.querySelectorAll("form .status").forEach((status) => { status.textContent = ""; });
      document.getElementById("routing-card").innerHTML = "<h2>Routing Insight</h2><p>Verify operator credentials before analyzing a dataset.</p>";
      document.getElementById("partition-card").innerHTML = "<h2>Partition Preview</h2><p>Verify operator credentials before requesting a partition preview.</p>";
      document.getElementById("store-analysis-card").innerHTML = "<h2>Metadata Relation &amp; Store Analysis</h2><p>Verify operator credentials before requesting store analysis.</p>";
    }
    loadSummary();
    loadMetadata();
  });
});
