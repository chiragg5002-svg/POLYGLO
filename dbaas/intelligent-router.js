/*
 * Intelligent storage routing for new collections.
 *
 * Reuses MAESTRO's existing analysis pipeline unchanged
 * (data-profiler -> store-analysis-engine: rule-based scoring + optional
 * Ollama + 60/40 hybrid). This module only adapts it for application
 * data and adds the SAFETY layer: the LLM can only contribute scores,
 * it never executes anything, and the final store is validated against
 * an allow-list here. Low-confidence or invalid outcomes fall back to
 * PostgreSQL.
 */
const { analyzeStore, STORE_KEYS } = require("../store-analysis-engine");
const { getConfig } = require("./config");

const DEFAULT_STORE = "postgresql";

function withTimeout(fn, ms) {
  return (args) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Ollama timed out after ${ms}ms`)), ms);
    Promise.resolve().then(() => fn(args)).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); });
  });
}

/*
 * @param {object[]} rows       sample documents (>=1)
 * @param {string}   name       collection name (used as a hint, like a filename)
 * @param {object}   [opts]     { callOllamaFn, useOllama }
 * @returns {{ dbType, reason, source, confidence, scores, warnings }}
 */
async function recommendStorage(rows, name, opts = {}) {
  const cfg = getConfig();
  const useOllama = opts.useOllama !== undefined ? opts.useOllama : cfg.routingUseOllama;
  const unavailable = async () => { throw new Error("Ollama disabled by configuration"); };
  let callOllamaFn = useOllama ? opts.callOllamaFn : unavailable;
  if (useOllama) {
    // eslint-disable-next-line global-require
    const base = opts.callOllamaFn || require("../gemini-service").callOllama;
    callOllamaFn = withTimeout(base, cfg.routingTimeoutMs);
  }

  let analysis;
  try {
    analysis = await analyzeStore({ rows, originalName: name, callOllamaFn });
  } catch (error) {
    return {
      dbType: DEFAULT_STORE,
      reason: `Analysis failed (${error.message}); defaulted to ${DEFAULT_STORE}.`,
      source: "fallback", confidence: 0, scores: null, warnings: ["analysis_failed"],
    };
  }

  const hybrid = analysis.hybrid || {};
  const candidate = hybrid.recommendation;
  const confidence = Number(hybrid.confidence) || 0;
  const ollamaUsed = Boolean(analysis.ollama && analysis.ollama.available);
  const source = ollamaUsed ? "hybrid(rule-based+ollama)" : "rule-based";

  if (!STORE_KEYS.includes(candidate)) {
    return { dbType: DEFAULT_STORE, reason: `Unrecognised recommendation; defaulted to ${DEFAULT_STORE}.`,
      source: "fallback", confidence: 0, scores: hybrid.scores || null, warnings: ["invalid_recommendation"] };
  }
  if (confidence < cfg.routingMinConfidence) {
    return { dbType: DEFAULT_STORE, reason: `Low confidence (${confidence}); defaulted to ${DEFAULT_STORE}. Signals: ${(hybrid.reasons || []).slice(0, 2).join("; ")}`,
      source: "fallback", confidence, scores: hybrid.scores || null, warnings: ["low_confidence"] };
  }
  return {
    dbType: candidate,
    reason: (hybrid.reasons || []).slice(0, 3).join(" ") || `Selected ${candidate}.`,
    source, confidence, scores: hybrid.scores || null, // Warnings can embed backend error text (hosts, URLs): strip details before they reach API responses.
    warnings: (analysis.warnings || []).map((w) => String(w).replace(/\s*\([^)]*\)\.?\s*$/, "").slice(0, 200)),
  };
}

module.exports = { recommendStorage, DEFAULT_STORE };
