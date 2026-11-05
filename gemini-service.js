const http = require("http");

const OLLAMA_HOST = process.env.OLLAMA_HOST || "127.0.0.1";
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11434);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 3000);

const ALLOWED_TARGETS = ["postgres", "mongodb", "elasticsearch", "local"];
const ALLOWED_CONFIDENCE = ["high", "medium", "low"];

function summarizeRows(rows = []) {
  return rows
    .slice(0, 8)
    .map((row, index) => {
      const keys = Object.keys(row || {}).slice(0, 8);

      return `${index + 1}. ${keys
        .map((key) => `${key}:${row[key]}`)
        .join(" | ")}`;
    })
    .join("\n");
}

function safeStringifyMetadata(metadata) {
  try {
    return JSON.stringify(metadata ?? {});
  } catch (error) {
    // Handles circular references or other non-serializable values.
    return '{"note":"metadata could not be serialized"}';
  }
}

function buildRoutingPrompt({
  rows = [],
  originalName = "",
  metadata = {},
} = {}) {
  const schema = rows[0]
    ? Object.keys(rows[0]).slice(0, 10).join(", ")
    : "unknown";

  const preview = summarizeRows(rows);

  return `
You are MAESTRO, an intelligent polyglot database routing assistant.

Your task is to recommend the best database/storage target for the dataset.

Allowed targets:
- postgres
- mongodb
- elasticsearch
- local

Rules:
- Use postgres for flat, structured tabular data with relational characteristics.
- Use mongodb for JSON/document datasets, especially when they contain nested objects, arrays, or flexible schemas.
- Use elasticsearch for search-heavy text, logs, events, or document datasets where full-text search is important.
- Use local only when there is insufficient information.
- If the dataset filename ends with .json, prefer mongodb when the sample contains nested objects, arrays, or flexible document structures.
- If the dataset filename ends with .csv and the rows are flat tabular records, prefer postgres.
- Do not choose postgres merely because a JSON dataset has simple top-level fields.
- Consider the filename, schema, metadata, and sample rows together when making the recommendation.

Return ONLY valid JSON.
Do not use markdown.
Do not add explanations outside the JSON.

Required JSON format:
{
  "target": "postgres",
  "confidence": "high",
  "reason": "short explanation",
  "suggestedCollection": "name"
}

Dataset name:
${originalName || "unknown"}

Observed schema fields:
${schema}

Metadata:
${safeStringifyMetadata(metadata)}

Sample rows:
${preview || "No sample rows available."}

Choose the most suitable target based on the rules above.

Important: Do not hard-code "mongodb" as the answer. You must still choose between postgres, mongodb, elasticsearch, and local based on the dataset.
`;
}

// ------------------------------------------------------------
// Metadata Relation & Hybrid Store Analysis — Ollama prompt
// ------------------------------------------------------------
// A second, independent prompt builder for the new hybrid
// store-analysis feature (store-analysis-engine.js). Deliberately
// separate from buildRoutingPrompt() above (different question,
// different required JSON shape) but reuses callOllama() below —
// there is still exactly one place in the app that talks to Ollama
// over HTTP.
function buildStoreAnalysisPrompt({
  metadata = {},
  relationships = {},
  originalName = "",
} = {}) {
  return `
You are MAESTRO, an intelligent polyglot database routing assistant.

Analyze the dataset metadata and relationship summary below and score how
suitable this dataset is for each of three storage targets: PostgreSQL,
MongoDB, and Elasticsearch.

Consider:
- semantic meaning of the dataset
- data structure (flat/tabular vs nested/document)
- likely usage
- relational characteristics (keys, relationships)
- document characteristics (nested objects/arrays, flexible schema)
- search/text characteristics (free text, descriptions, logs)

Return ONLY valid JSON. Do not use markdown. Do not add explanations
outside the JSON.

Required JSON format:
{
  "postgresql": 0,
  "mongodb": 0,
  "elasticsearch": 0,
  "recommended_store": "postgresql",
  "confidence": 0,
  "reasons": ["short reason", "short reason"]
}

Rules:
- "postgresql", "mongodb", and "elasticsearch" must each be a number from 0 to 100.
- "recommended_store" must be exactly one of "postgresql", "mongodb", "elasticsearch".
- "confidence" must be a number from 0 to 100.
- Base your scores only on the metadata and relationships given below — do not invent facts about the data.
- Do not default to the same recommendation for every dataset.

Dataset name:
${originalName || "unknown"}

Dataset metadata:
${safeStringifyMetadata(metadata)}

Relationship analysis:
${safeStringifyMetadata(relationships)}
`;
}

function parseRoutingRecommendation(responseText = "") {
  let cleaned = String(responseText).trim();

  // Remove markdown code fences if the model adds them.
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Extract the first JSON object if extra text was returned.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);

    const target = ALLOWED_TARGETS.includes(
      String(parsed.target || "").toLowerCase(),
    )
      ? String(parsed.target).toLowerCase()
      : "local";

    const confidence = ALLOWED_CONFIDENCE.includes(
      String(parsed.confidence || "").toLowerCase(),
    )
      ? String(parsed.confidence).toLowerCase()
      : "medium";

    return {
      target,
      confidence,
      reason: parsed.reason || "Generated by local Ollama model.",
      suggestedCollection: parsed.suggestedCollection || null,
    };
  } catch (error) {
    return {
      target: "local",
      confidence: "low",
      reason: "Ollama response could not be parsed as JSON.",
      suggestedCollection: null,
    };
  }
}

function callOllama({ prompt }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: "json",
      options: {
        temperature: 0.1,
      },
    });

    const options = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: "/api/generate",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const request = http.request(options, (response) => {
      let data = "";

      response.on("data", (chunk) => {
        data += chunk;
      });

      response.on("error", (error) => {
        reject(new Error(`Ollama response stream error: ${error.message}`));
      });

      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(
            new Error(`Ollama returned HTTP ${response.statusCode}: ${data}`),
          );
        }

        try {
          const payload = JSON.parse(data);

          const text = payload?.response || "";

          if (!text) {
            return reject(new Error("Ollama returned an empty response."));
          }

          resolve(text);
        } catch (error) {
          reject(new Error("Ollama response was not valid JSON."));
        }
      });
    });

    // Guard against a hung connection (model loading, server stuck, etc.)
    request.setTimeout(OLLAMA_TIMEOUT_MS, () => {
      request.destroy(
        new Error(`Ollama request timed out after ${OLLAMA_TIMEOUT_MS}ms.`),
      );
    });

    request.on("error", (error) => {
      reject(
        new Error(
          `Could not connect to Ollama at ${OLLAMA_HOST}:${OLLAMA_PORT}. ` +
            `Make sure Ollama is running. (${error.message})`,
        ),
      );
    });

    request.write(body);
    request.end();
  });
}

module.exports = {
  buildRoutingPrompt,
  buildStoreAnalysisPrompt,
  parseRoutingRecommendation,
  callOllama,
};

