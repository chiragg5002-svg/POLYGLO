/*
 * ============================================================
 * MAESTRO routing engine
 * ============================================================
 *
 * A hybrid, deterministic-first recommendation engine that decides
 * which of the supported targets (postgres, mongodb, elasticsearch,
 * or local) a dataset should be routed to.
 *
 * Pipeline:
 *   1. Deterministic rules run first. If a rule is confident (a
 *      "strong" match), its answer is returned immediately and
 *      Ollama is never called.
 *   2. If no rule is confident, the local Ollama model is asked for
 *      a second opinion.
 *   3. Ollama's raw output is validated against the allowed targets
 *      before it's trusted at all.
 *   4. Even a validated Ollama answer is checked against the (weak)
 *      rule signal one more time — if Ollama recommends postgres for
 *      data that even weakly looks like logs/search/nested JSON,
 *      the deterministic rule wins instead. This is the safety net
 *      described in the project requirements: "log data must never
 *      be routed to Postgres merely because Ollama said so".
 *   5. If Ollama is unreachable, times out, or returns something
 *      that can't be validated as a real recommendation, the engine
 *      falls back to the rule-based signal instead of failing.
 *
 * Every result has the same shape:
 *   { target, confidence, reason, pattern, source, suggestedCollection }
 * where source is exactly one of "rules", "ollama", "fallback".
 */

const ALLOWED_TARGETS = ["postgres", "mongodb", "elasticsearch", "local"];
const ALLOWED_CONFIDENCE = ["high", "medium", "low"];

// Canonical log-oriented field names (unchanged from the original
// deterministic rule in server.js, kept here so there is exactly one
// place that owns this list).
const LOG_FIELDS = ["timestamp", "level", "message", "service", "log", "event"];

// Full-text/search-oriented field names called out explicitly in the
// project requirements, distinct from the log fields above so the
// detected pattern can say *why* Elasticsearch was chosen.
const FULLTEXT_FIELDS = ["title", "content", "description", "text"];

// Broader, weaker search-intent signal: words that show up in sample
// values or the filename even when the column names themselves don't
// match FULLTEXT_FIELDS exactly (kept from the original rule-based
// heuristic in database-service.js for continuity).
const SEARCH_HINT_REGEX = /title|content|description|text|search|article|document/i;

// order/customer/invoice/payment/user/account — the same regex
// already used by inferRoutingRecommendation() in database-service.js,
// reused here so profiling, routing, and this engine all agree.
const TRANSACTIONAL_REGEX = /order|customer|invoice|payment|user|account/i;

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

function isJsonFile(originalName = "") {
  return String(originalName || "").toLowerCase().endsWith(".json");
}

function collectColumnNames(rows) {
  const names = new Set();
  rows.slice(0, 20).forEach((row) => {
    Object.keys(row || {}).forEach((key) => names.add(String(key).toLowerCase()));
  });
  return names;
}

function sampleText(rows) {
  try {
    return JSON.stringify(rows.slice(0, 5)).toLowerCase();
  } catch (error) {
    return "";
  }
}

function hasNestedValues(rows) {
  return rows.some((row) =>
    Object.values(row || {}).some((value) => value !== null && typeof value === "object"),
  );
}

// Derives a safe, human-friendly collection/table name from the
// uploaded filename (e.g. "application_logs.json" -> "application_logs").
function suggestCollectionName(originalName, fallback = "dataset") {
  const base = String(originalName || "").replace(/\.(json|csv|tsv)$/i, "");
  const sanitized = base.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || fallback;
}

// ------------------------------------------------------------
// Deterministic pattern detection
// ------------------------------------------------------------
// Always returns a result — never null — so there is always a safe
// default to fall back to if Ollama can't be trusted. `isStrong`
// marks whether the signal is confident enough to skip Ollama
// entirely (and to override an unsafe Ollama answer later).
function detectPattern({ rows = [], originalName = "" } = {}) {
  const columnNames = collectColumnNames(rows);
  const text = sampleText(rows);
  const columnText = [...columnNames].join(" ");

  // 1. Nested JSON -> MongoDB (arrays/embedded objects, flexible schema)
  if (isJsonFile(originalName) && hasNestedValues(rows)) {
    return {
      pattern: "nestedDocument",
      target: "mongodb",
      confidence: "high",
      reason:
        "JSON dataset contains nested objects or arrays, which fits MongoDB's flexible document model.",
      isStrong: true,
    };
  }

  // 2. Application logs -> Elasticsearch
  const matchedLogFields = LOG_FIELDS.filter((field) => columnNames.has(field));
  if (matchedLogFields.length >= 2) {
    return {
      pattern: "applicationLogs",
      target: "elasticsearch",
      confidence: "high",
      reason: `Log-oriented fields present (${matchedLogFields.join(", ")}), making Elasticsearch the best fit for search and retrieval over log/event data.`,
      isStrong: true,
    };
  }

  // 3. Full-text search documents -> Elasticsearch
  const matchedFullTextFields = FULLTEXT_FIELDS.filter((field) => columnNames.has(field));
  const isSearchHeavy =
    SEARCH_HINT_REGEX.test(text) || String(originalName || "").toLowerCase().includes("search");

  if (matchedFullTextFields.length >= 2 || (matchedFullTextFields.length >= 1 && isSearchHeavy)) {
    return {
      pattern: "fullTextSearch",
      target: "elasticsearch",
      confidence: "high",
      reason: `Search-oriented fields present (${matchedFullTextFields.join(", ") || "title/content/description"}), making Elasticsearch the best fit for full-text search.`,
      isStrong: true,
    };
  }

  // 4. Transactional records -> PostgreSQL
  //
  // Deliberately checked against COLUMN NAMES only, not sample row
  // values/text: matching against values as well would let an
  // incidental word like "user" inside a log message ("user login
  // failed") falsely trigger this rule and mask real log/search data
  // — exactly the kind of unsafe misclassification these rules exist
  // to prevent.
  const isTransactional = TRANSACTIONAL_REGEX.test(columnText);
  if (isTransactional) {
    return {
      pattern: "transactional",
      target: "postgres",
      confidence: "high",
      reason:
        "Order/customer/invoice/payment/account-style fields suggest transactional records that benefit from PostgreSQL's strong relationships and constraints.",
      isStrong: true,
    };
  }

  // 5. Weak search/log signal — not enough to bypass Ollama, but
  // enough that Postgres should never be trusted for it later.
  if (matchedLogFields.length === 1 || matchedFullTextFields.length === 1) {
    const hintField = matchedLogFields[0] || matchedFullTextFields[0];
    return {
      pattern: "possibleSearchOrLogData",
      target: "elasticsearch",
      confidence: "low",
      reason: `A single search/log-oriented field ("${hintField}") was found — not conclusive on its own, but Elasticsearch is the safer default and Postgres should be avoided.`,
      isStrong: false,
    };
  }

  // 6. Default: plain structured/tabular data -> PostgreSQL
  return {
    pattern: "tabular",
    target: "postgres",
    confidence: "low",
    reason:
      "No nested, log, search, or transactional signal was detected; flat structured data defaults to PostgreSQL.",
    isStrong: false,
  };
}

// A rule-confirmed-unsafe combination: Ollama recommending Postgres
// for anything that even weakly looks like log/search/nested data.
// (Nested/log/search patterns with isStrong === true never reach this
// check at all, since they bypass Ollama outright — this specifically
// guards the weak-signal case where Ollama was consulted.)
function isUnsafeTarget({ ruleSignal, target }) {
  if (target !== "postgres") return false;
  return ["possibleSearchOrLogData", "nestedDocument", "applicationLogs", "fullTextSearch"].includes(
    ruleSignal.pattern,
  );
}

// ------------------------------------------------------------
// Ollama response validation
// ------------------------------------------------------------
// Independent of gemini-service.js's own parseRoutingRecommendation()
// (which normalizes an invalid target to "local" and keeps going) —
// this engine needs to know explicitly whether Ollama's answer was
// usable at all, so it can label the result "fallback" instead of
// silently accepting a defaulted-to-local answer as if Ollama meant it.
function interpretOllamaResponse(responseText = "") {
  let cleaned = String(responseText || "").trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    return { valid: false, reason: "Ollama response was not valid JSON." };
  }

  if (!parsed || typeof parsed !== "object") {
    return { valid: false, reason: "Ollama response was not a JSON object." };
  }

  const rawTarget = String(parsed.target || "").toLowerCase();
  if (!ALLOWED_TARGETS.includes(rawTarget)) {
    return {
      valid: false,
      reason: `Ollama returned an unrecognized target ("${parsed.target}").`,
    };
  }

  const rawConfidence = String(parsed.confidence || "").toLowerCase();
  const confidence = ALLOWED_CONFIDENCE.includes(rawConfidence) ? rawConfidence : "medium";

  return {
    valid: true,
    target: rawTarget,
    confidence,
    reason: parsed.reason || "Generated by local Ollama model.",
    suggestedCollection: parsed.suggestedCollection || null,
  };
}

// ------------------------------------------------------------
// Result shaping
// ------------------------------------------------------------
function finalizeResult({ target, confidence, reason, pattern, source, suggestedCollection }) {
  return {
    target,
    confidence,
    reason,
    pattern,
    source,
    suggestedCollection: suggestedCollection || null,
  };
}

// ------------------------------------------------------------
// Main entry point
// ------------------------------------------------------------
// callOllamaFn/buildPromptFn are injectable so tests can exercise the
// full hybrid pipeline (including "Ollama unavailable" and "invalid
// response" scenarios) without a real Ollama server. They default to
// the real implementations in gemini-service.js.
async function getRoutingRecommendation({
  rows = [],
  originalName = "",
  metadata = {},
  callOllamaFn,
  buildPromptFn,
} = {}) {
  // eslint-disable-next-line global-require
  const gemini = require("./gemini-service");
  const callOllama = callOllamaFn || gemini.callOllama;
  const buildRoutingPrompt = buildPromptFn || gemini.buildRoutingPrompt;

  const ruleSignal = detectPattern({ rows, originalName });
  const suggestedCollection = suggestCollectionName(
    originalName,
    ruleSignal.pattern === "applicationLogs" ? "application_logs" : "dataset",
  );

  // Strong deterministic match: never involve Ollama at all.
  if (ruleSignal.isStrong) {
    return finalizeResult({
      target: ruleSignal.target,
      confidence: ruleSignal.confidence,
      reason: ruleSignal.reason,
      pattern: ruleSignal.pattern,
      source: "rules",
      suggestedCollection,
    });
  }

  const prompt = buildRoutingPrompt({ rows, originalName, metadata });

  let ollamaOutcome;
  try {
    const responseText = await callOllama({ prompt });
    ollamaOutcome = interpretOllamaResponse(responseText);
  } catch (error) {
    // Ollama unreachable, timed out, or errored — safe fallback.
    return finalizeResult({
      target: ruleSignal.target,
      confidence: "low",
      reason: `Ollama is unavailable (${error.message}); using the rule-based default instead: ${ruleSignal.reason}`,
      pattern: ruleSignal.pattern,
      source: "fallback",
      suggestedCollection,
    });
  }

  if (!ollamaOutcome.valid) {
    // Ollama responded, but not with something we can trust.
    return finalizeResult({
      target: ruleSignal.target,
      confidence: "low",
      reason: `Ollama's response could not be used (${ollamaOutcome.reason}); using the rule-based default instead: ${ruleSignal.reason}`,
      pattern: ruleSignal.pattern,
      source: "fallback",
      suggestedCollection,
    });
  }

  if (isUnsafeTarget({ ruleSignal, target: ollamaOutcome.target })) {
    // Deterministic rules override an incorrect/unsafe LLM response.
    return finalizeResult({
      target: ruleSignal.target,
      confidence: ruleSignal.confidence === "low" ? "medium" : ruleSignal.confidence,
      reason: `Overriding Ollama's recommendation ("${ollamaOutcome.target}") because ${ruleSignal.reason}`,
      pattern: ruleSignal.pattern,
      source: "rules",
      suggestedCollection,
    });
  }

  return finalizeResult({
    target: ollamaOutcome.target,
    confidence: ollamaOutcome.confidence,
    reason: ollamaOutcome.reason,
    pattern: ruleSignal.pattern,
    source: "ollama",
    suggestedCollection: ollamaOutcome.suggestedCollection || suggestedCollection,
  });
}

module.exports = {
  ALLOWED_TARGETS,
  ALLOWED_CONFIDENCE,
  LOG_FIELDS,
  FULLTEXT_FIELDS,
  TRANSACTIONAL_REGEX,
  SEARCH_HINT_REGEX,
  detectPattern,
  isUnsafeTarget,
  interpretOllamaResponse,
  suggestCollectionName,
  getRoutingRecommendation,
};
