/*
 * ============================================================
 * MAESTRO — Metadata Relation & Hybrid Store Analysis
 * ============================================================
 *
 * A NEW, additive feature. It does not replace or modify the
 * existing deterministic-first routing pipeline in
 * routing-engine.js (used by POST /routing/recommend) — that
 * pipeline is left completely untouched.
 *
 * Instead this module builds a second, independent analysis on top
 * of the SAME building blocks the rest of the app already has:
 *
 *   - data-profiler.js        -> per-column metadata (reused, not
 *                                 recomputed)
 *   - partitioner.js          -> IDENTIFIER_NAME_REGEX (reused for
 *                                 primary/foreign-key detection)
 *   - routing-engine.js       -> LOG_FIELDS / FULLTEXT_FIELDS /
 *                                 TRANSACTIONAL_REGEX / SEARCH_HINT_REGEX
 *                                 (reused for rule-based scoring, so
 *                                 the two analyses never disagree
 *                                 about what "looks like a log field"
 *                                 means)
 *   - gemini-service.js       -> callOllama() (reused as-is; only a
 *                                 new prompt builder,
 *                                 buildStoreAnalysisPrompt, was
 *                                 added there — no new HTTP/JSON
 *                                 handling code was duplicated)
 *
 * Pipeline (see server.js POST /analysis/store):
 *
 *   metadata analysis -> relationship analysis -> rule-based store
 *   scoring -> Ollama store scoring (optional) -> weighted hybrid
 *   decision (60% rule-based / 40% Ollama)
 *
 * Every score is 0-100. Nothing here claims a measured accuracy or
 * benchmark — scores are explainable point totals, and every score
 * carries the reasons that produced it.
 */

const { IDENTIFIER_NAME_REGEX } = require("./partitioner");
const {
  LOG_FIELDS,
  FULLTEXT_FIELDS,
  TRANSACTIONAL_REGEX,
  SEARCH_HINT_REGEX,
} = require("./routing-engine");

const STORE_KEYS = ["postgresql", "mongodb", "elasticsearch"];

// A Text/Mixed column counts as "categorical" (rather than free
// text) when it repeats a small set of values and those values are
// short — the same intuition data-profiler.js and partitioner.js
// already use for "short text" vs. "long/free text", just named for
// this feature's own metadata summary.
const CATEGORICAL_CARDINALITY_THRESHOLD = 0.5;
const CATEGORICAL_MAX_AVERAGE_LENGTH = 30;

// A foreign-key/grouping candidate needs at least this many rows to
// mean anything — a 1-2 row sample can't tell repetition from
// coincidence.
const MIN_ROWS_FOR_RELATIONSHIPS = 2;

// How many rows to sample when walking raw JSON for nesting depth /
// repeated-structure detection. Bounded so a huge upload doesn't
// make this feature slow.
const STRUCTURE_SAMPLE_SIZE = 10;

// ------------------------------------------------------------
// Small numeric helpers
// ------------------------------------------------------------

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function average(numbers) {
  if (!numbers.length) return 0;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function round(value, decimals = 4) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function averageSampleLength(column) {
  const samples = Array.isArray(column.sampleValues) ? column.sampleValues : [];
  if (!samples.length) return 0;
  return average(samples.map((value) => String(value).length));
}

// ------------------------------------------------------------
// Raw-value structure helpers (nesting depth / repeated shapes)
// ------------------------------------------------------------
// Independent of data-profiler.js's isNested/nestedType (which
// classify a whole COLUMN). These walk actual values so the feature
// can report a numeric depth and detect repeated array-of-object
// shapes, neither of which data-profiler.js computes today.

function valueDepth(value) {
  if (value === null || typeof value !== "object") return 0;

  const entries = Array.isArray(value) ? value : Object.values(value);

  if (!entries.length) return 1;

  return 1 + Math.max(0, ...entries.map(valueDepth));
}

function computeDatasetNestedDepth(rows = [], sampleSize = STRUCTURE_SAMPLE_SIZE) {
  let max = 0;

  rows.slice(0, sampleSize).forEach((row) => {
    if (!row || typeof row !== "object") return;
    Object.values(row).forEach((value) => {
      max = Math.max(max, valueDepth(value));
    });
  });

  return max;
}

// For each array-typed column, checks whether its elements (when
// they're objects) share a consistent set of keys across rows — a
// "repeated structure" (e.g. every order has the same shape of
// line-item objects), as opposed to an array of unrelated blobs.
function detectRepeatedStructures(rows = [], arrayColumns = [], sampleSize = STRUCTURE_SAMPLE_SIZE) {
  const sample = rows.slice(0, sampleSize);

  return arrayColumns
    .map((column) => {
      const keySets = [];

      sample.forEach((row) => {
        const value = row ? row[column.column] : undefined;
        if (!Array.isArray(value)) return;

        value.forEach((element) => {
          if (element && typeof element === "object" && !Array.isArray(element)) {
            keySets.push(Object.keys(element).sort().join(","));
          }
        });
      });

      if (keySets.length < 2) {
        return { field: column.column, repeated: false, reason: "Not enough object elements sampled to compare." };
      }

      const distinctShapes = new Set(keySets);
      const repeated = distinctShapes.size === 1;

      return {
        field: column.column,
        repeated,
        reason: repeated
          ? `Every sampled element of "${column.column}" shares the same set of keys, indicating a repeated sub-document structure.`
          : `Sampled elements of "${column.column}" have ${distinctShapes.size} different key shapes.`,
      };
    })
    .filter((entry) => entry.repeated || entry.reason);
}

// ------------------------------------------------------------
// Text-density helpers
// ------------------------------------------------------------
// textDensity is the fraction of columns that are free-text-like
// (not categorical, not numeric/date/nested); averageTextLength is
// the mean sample-value length across just those columns. Both are
// plain, explainable ratios — not a claimed accuracy metric.
function computeTextStats(columns) {
  const textLikeColumns = columns.filter((column) => {
    if (column.type !== "Text" && column.type !== "Mixed") return false;
    // Identifier-style columns (order_id, uuid, ...) are short,
    // high-cardinality strings, not free text — without this check
    // they'd slip past the cardinality-based categorical check below
    // (which only catches LOW-cardinality short strings) and get
    // miscounted as search-worthy text.
    if (IDENTIFIER_NAME_REGEX.test(column.column)) return false;
    const avgLength = averageSampleLength(column);
    const isCategorical =
      column.cardinality <= CATEGORICAL_CARDINALITY_THRESHOLD && avgLength <= CATEGORICAL_MAX_AVERAGE_LENGTH;
    return !isCategorical;
  });

  const lengths = textLikeColumns.map(averageSampleLength);

  return {
    averageTextLength: round(average(lengths), 2),
    textDensity: columns.length ? round(textLikeColumns.length / columns.length, 4) : 0,
    textLikeColumns,
  };
}

// ------------------------------------------------------------
// 1. METADATA ANALYSIS
// ------------------------------------------------------------
// Builds the structured metadata summary requested by the feature
// spec, entirely from data-profiler.js's existing column profiles —
// no re-parsing of the dataset happens here.
function buildDatasetMetadata(profile, rows = []) {
  const columns = profile.columns || [];

  const fieldTypes = {};
  const nullPercentage = {};
  const uniqueValues = {};
  const cardinality = {};

  const numericFields = [];
  const categoricalFields = [];
  const textFields = [];
  const dateFields = [];
  const arrays = [];
  const objects = [];
  const identifierLikeFields = [];

  columns.forEach((column) => {
    fieldTypes[column.column] = column.type;
    nullPercentage[column.column] = column.missingPercentage;
    uniqueValues[column.column] = column.uniqueValues;
    cardinality[column.column] = column.cardinality;

    if (column.type === "Numeric") {
      numericFields.push(column.column);
    } else if (column.type === "Date") {
      dateFields.push(column.column);
    } else if (column.type === "Array") {
      arrays.push(column.column);
    } else if (column.type === "Object" || column.type === "Nested") {
      objects.push(column.column);
    } else if (column.type === "Boolean") {
      categoricalFields.push(column.column);
    } else if (column.type === "Text" || column.type === "Mixed") {
      if (IDENTIFIER_NAME_REGEX.test(column.column)) {
        // Tracked under identifierLikeFields below instead — a
        // short, high-cardinality id string is neither a category
        // nor free text.
      } else {
        const avgLength = averageSampleLength(column);
        const isCategorical =
          column.cardinality <= CATEGORICAL_CARDINALITY_THRESHOLD && avgLength <= CATEGORICAL_MAX_AVERAGE_LENGTH;
        if (isCategorical) {
          categoricalFields.push(column.column);
        } else {
          textFields.push(column.column);
        }
      }
    }

    if (IDENTIFIER_NAME_REGEX.test(column.column) || column.cardinality >= 0.95) {
      identifierLikeFields.push(column.column);
    }
  });

  const { averageTextLength, textDensity } = computeTextStats(columns);
  const arrayColumns = columns.filter((column) => column.type === "Array");
  const repeatedStructures = detectRepeatedStructures(rows, arrayColumns);

  return {
    dataset: profile.dataset,
    format: profile.format,
    rowCount: profile.rowCount,
    fieldCount: profile.columnCount,
    fields: columns.map((column) => column.column),
    fieldTypes,
    nullPercentage,
    uniqueValues,
    cardinality,
    numericFields,
    categoricalFields,
    textFields,
    dateFields,
    averageTextLength,
    textDensity,
    nestedDepth: computeDatasetNestedDepth(rows),
    arrays,
    objects,
    repeatedStructures,
    identifierLikeFields: [...new Set(identifierLikeFields)],
    hasNestedData: !!profile.hasNestedData,
    isJson: profile.format === "json",
  };
}

// ------------------------------------------------------------
// 2. RELATIONSHIP ANALYSIS
// ------------------------------------------------------------
// Deliberately conservative: every relation is phrased as a
// "candidate"/"suggests", never a certainty, and confidence is
// derived directly from cardinality (how close a column is to
// unique, or how much it repeats) rather than asserted outright.
function analyzeRelationships({ profile }) {
  const columns = profile.columns || [];
  const rowCount = profile.rowCount || 0;
  const relations = [];

  if (rowCount < MIN_ROWS_FOR_RELATIONSHIPS) {
    return { relations, confidence: 0 };
  }

  const idLikeColumns = columns.filter(
    (column) => IDENTIFIER_NAME_REGEX.test(column.column) && !column.isNested,
  );

  idLikeColumns.forEach((column) => {
    const entity = column.column.toLowerCase().replace(/_?id$/i, "") || column.column;

    if (column.cardinality >= 0.95) {
      relations.push({
        type: "primary-key-candidate",
        field: column.column,
        confidence: clampScore(column.cardinality * 100),
        reason: `"${column.column}" is nearly unique (cardinality ${column.cardinality}) across ${rowCount} row(s), which fits a primary key.`,
      });
    } else if (column.cardinality > 0) {
      relations.push({
        type: "foreign-key-candidate",
        field: column.column,
        confidence: clampScore((1 - column.cardinality) * 80),
        reason: `"${column.column}" repeats across rows (cardinality ${column.cardinality}), suggesting a foreign key referencing a separate "${entity}" entity — a possible one-to-many relationship.`,
      });
    }
  });

  columns.forEach((column) => {
    if (column.isNested || IDENTIFIER_NAME_REGEX.test(column.column)) return;

    const isLowCardinalityCategorical =
      column.uniqueValues > 1 &&
      column.cardinality > 0 &&
      column.cardinality <= 0.2 &&
      (column.type === "Text" || column.type === "Boolean" || column.type === "Mixed");

    if (isLowCardinalityCategorical) {
      relations.push({
        type: "categorical-grouping",
        field: column.column,
        confidence: clampScore((1 - column.cardinality) * 60),
        reason: `"${column.column}" has only ${column.uniqueValues} distinct value(s) across ${rowCount} row(s), suggesting it groups records into categories.`,
      });
    }
  });

  const foreignKeyCandidates = relations.filter((relation) => relation.type === "foreign-key-candidate");

  if (foreignKeyCandidates.length >= 2) {
    relations.push({
      type: "many-to-many-indicator",
      field: foreignKeyCandidates.map((relation) => relation.field).join(", "),
      confidence: clampScore(
        average(foreignKeyCandidates.map((relation) => relation.confidence)) / 2,
      ),
      reason: `Multiple repeating identifier-style fields (${foreignKeyCandidates
        .map((relation) => relation.field)
        .join(", ")}) appear together, which can indicate a many-to-many join/association table. Not certain from column names alone.`,
    });
  }

  const confidence = relations.length
    ? clampScore(average(relations.map((relation) => relation.confidence)))
    : 0;

  return { relations, confidence };
}

// ------------------------------------------------------------
// 3. RULE-BASED STORE ANALYSIS
// ------------------------------------------------------------
// Deterministic, explainable point totals. Reuses the exact same
// field-name lists/regexes as routing-engine.js's detectPattern()
// so this feature's "rule-based" signal never contradicts the
// existing /routing/recommend endpoint about what looks like a log,
// search, or transactional field.
function ruleBasedStoreAnalysis({ profile, relationships, originalName = "", rows = [] }) {
  const columns = profile.columns || [];
  const columnNames = columns.map((column) => column.column.toLowerCase());
  const columnText = columnNames.join(" ");
  const sampleText = JSON.stringify((rows || []).slice(0, 5)).toLowerCase();
  const hasNestedData = !!profile.hasNestedData;
  const nestedDepth = computeDatasetNestedDepth(rows);
  const arrayColumns = columns.filter((column) => column.type === "Array");
  const identifierColumns = columns.filter((column) => IDENTIFIER_NAME_REGEX.test(column.column));
  const numericColumns = columns.filter((column) => column.type === "Numeric");
  const mixedColumns = columns.filter((column) => column.type === "Mixed");
  const { averageTextLength, textDensity, textLikeColumns } = computeTextStats(columns);

  // ---------------- PostgreSQL ----------------
  let pgScore = 0;
  const pgReasons = [];

  if (!hasNestedData) {
    pgScore += 35;
    pgReasons.push("Dataset is flat/tabular with no nested objects or arrays.");
  }
  if (identifierColumns.length > 0) {
    pgScore += 15;
    pgReasons.push(
      `Identifier-like field(s) present (${identifierColumns.map((column) => column.column).join(", ")}).`,
    );
  }
  if (numericColumns.length > 0) {
    pgScore += 10;
    pgReasons.push(`${numericColumns.length} numeric field(s) fit relational columns and constraints well.`);
  }
  const relationalSignals = (relationships.relations || []).filter(
    (relation) => relation.type === "primary-key-candidate" || relation.type === "foreign-key-candidate",
  );
  if (relationalSignals.length > 0) {
    pgScore += 20;
    pgReasons.push(
      `${relationalSignals.length} primary/foreign-key candidate(s) detected, suggesting relational structure.`,
    );
  }
  if (TRANSACTIONAL_REGEX.test(columnText)) {
    pgScore += 15;
    pgReasons.push("Order/customer/invoice/payment/account-style field names suggest transactional records.");
  }
  if (hasNestedData) {
    pgScore -= 15;
    pgReasons.push("Nested objects/arrays are present, which reduces PostgreSQL's natural fit.");
  }
  if (!pgReasons.length) pgReasons.push("No strong relational signal was detected.");

  // ---------------- MongoDB ----------------
  let mongoScore = 0;
  const mongoReasons = [];

  if (hasNestedData) {
    mongoScore += 45;
    mongoReasons.push("Dataset contains nested objects or arrays, which fits MongoDB's flexible document model.");
  }
  if (nestedDepth >= 2) {
    mongoScore += 15;
    mongoReasons.push(`Nesting depth of ${nestedDepth} indicates a genuinely hierarchical document shape.`);
  }
  if (arrayColumns.length > 0) {
    mongoScore += 15;
    mongoReasons.push(`${arrayColumns.length} array-typed field(s) present.`);
  }
  if (profile.format === "json") {
    mongoScore += 10;
    mongoReasons.push("Source file is JSON, a natural fit for a document store.");
  }
  if (mixedColumns.length > 0) {
    mongoScore += 10;
    mongoReasons.push(
      `${mixedColumns.length} field(s) show mixed/varying types across rows, suggesting a flexible/varying document structure.`,
    );
  }
  if (!hasNestedData) {
    mongoScore -= 10;
    mongoReasons.push("No nested structures were found, which weakens the case for a document store.");
  }
  if (!mongoReasons.length) mongoReasons.push("No strong document/nested signal was detected.");

  // ---------------- Elasticsearch ----------------
  let esScore = 0;
  const esReasons = [];

  const matchedFullTextFields = FULLTEXT_FIELDS.filter((field) => columnNames.includes(field));
  const matchedLogFields = LOG_FIELDS.filter((field) => columnNames.includes(field));

  if (matchedFullTextFields.length > 0) {
    esScore += 30;
    esReasons.push(`Search-oriented field name(s) present (${matchedFullTextFields.join(", ")}).`);
  }
  if (matchedLogFields.length > 0) {
    esScore += 25;
    esReasons.push(`Log-oriented field name(s) present (${matchedLogFields.join(", ")}).`);
  }
  if (textLikeColumns.length > 0) {
    const textScore = clampScore(textDensity * 100 * 0.3 + Math.min(averageTextLength, 100) * 0.15);
    esScore += textScore;
    esReasons.push(
      `${textLikeColumns.length} free-text field(s) with average length ~${averageTextLength} characters (text density ${textDensity}).`,
    );
  }
  // Long free text (paragraph-sized values) is the strongest sign that
  // full-text search, not relational filtering, is the main access path.
  // Independent of column density: one long "body"/"text" column is enough.
  if (textLikeColumns.length > 0 && averageTextLength >= 100) {
    esScore += 35;
    esReasons.push(`Long free-text values (average ~${averageTextLength} characters) favour full-text search.`);
  }
  const isSearchHinted =
    SEARCH_HINT_REGEX.test(sampleText) || SEARCH_HINT_REGEX.test(String(originalName || "").toLowerCase());
  if (isSearchHinted) {
    esScore += 10;
    esReasons.push("Sample values or the filename hint at search/document-oriented content.");
  }
  if (!esReasons.length) esReasons.push("No strong text-heavy, search, or log-oriented signal was detected.");

  return {
    postgresql: { score: clampScore(pgScore), reasons: pgReasons },
    mongodb: { score: clampScore(mongoScore), reasons: mongoReasons },
    elasticsearch: { score: clampScore(esScore), reasons: esReasons },
  };
}

// ------------------------------------------------------------
// 4. OLLAMA ANALYSIS
// ------------------------------------------------------------
// Validates Ollama's raw output against the required schema before
// trusting any of it. Never throws — an unusable or missing Ollama
// response just means { available: false }, which
// buildHybridDecision() below treats as "use rule-based only".
function interpretStoreAnalysisResponse(responseText = "") {
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

  const scores = {};
  for (const key of STORE_KEYS) {
    const raw = parsed[key];
    if (raw === undefined || raw === null || !Number.isFinite(Number(raw))) {
      return { valid: false, reason: `Ollama response is missing a numeric "${key}" score.` };
    }
    scores[key] = clampScore(raw);
  }

  let recommendedStore = String(parsed.recommended_store || "").toLowerCase();
  if (!STORE_KEYS.includes(recommendedStore)) {
    // Don't fail just because this one field is missing/invalid —
    // derive it from whichever score is highest instead.
    recommendedStore = STORE_KEYS.reduce((best, key) => (scores[key] > scores[best] ? key : best), STORE_KEYS[0]);
  }

  const confidence = clampScore(parsed.confidence !== undefined ? parsed.confidence : scores[recommendedStore]);

  let reasons = parsed.reasons;
  if (typeof reasons === "string") reasons = [reasons];
  if (!Array.isArray(reasons)) reasons = [];
  reasons = reasons.filter((reason) => typeof reason === "string" && reason.trim()).slice(0, 10);

  return { valid: true, scores, recommended_store: recommendedStore, confidence, reasons };
}

// callOllamaFn/buildPromptFn are injectable for tests (see
// routing-engine.js's getRoutingRecommendation, which uses the same
// pattern) — they default to the real gemini-service.js implementations.
async function ollamaStoreAnalysis({
  metadata,
  relationships,
  originalName = "",
  callOllamaFn,
  buildPromptFn,
} = {}) {
  // eslint-disable-next-line global-require
  const gemini = require("./gemini-service");
  const callOllama = callOllamaFn || gemini.callOllama;
  const buildPrompt = buildPromptFn || gemini.buildStoreAnalysisPrompt;

  const prompt = buildPrompt({ metadata, relationships, originalName });

  let responseText;
  try {
    responseText = await callOllama({ prompt });
  } catch (error) {
    return {
      available: false,
      error: error.message,
      scores: null,
      recommended_store: null,
      confidence: 0,
      reasons: [],
    };
  }

  const interpreted = interpretStoreAnalysisResponse(responseText);

  if (!interpreted.valid) {
    return {
      available: false,
      error: interpreted.reason,
      scores: null,
      recommended_store: null,
      confidence: 0,
      reasons: [],
    };
  }

  return {
    available: true,
    error: null,
    scores: interpreted.scores,
    recommended_store: interpreted.recommended_store,
    confidence: interpreted.confidence,
    reasons: interpreted.reasons,
  };
}

// ------------------------------------------------------------
// 5 & 6. HYBRID DECISION + DISAGREEMENT HANDLING
// ------------------------------------------------------------
// finalScore = ruleScore * 0.60 + ollamaScore * 0.40, per store.
// Falls back to finalScore = ruleScore (per store) whenever Ollama's
// answer isn't available/usable — never fails the analysis.
const RULE_WEIGHT = 0.6;
const OLLAMA_WEIGHT = 0.4;

function topStore(scoreMap) {
  return STORE_KEYS.reduce((best, key) => (scoreMap[key] > scoreMap[best] ? key : best), STORE_KEYS[0]);
}

function buildHybridDecision({ ruleBased, ollama }) {
  const weights = { ruleBased: RULE_WEIGHT, ollama: OLLAMA_WEIGHT };
  const warnings = [];
  const scores = {};

  const ollamaAvailable = !!(ollama && ollama.available && ollama.scores);

  STORE_KEYS.forEach((store) => {
    const ruleScore = ruleBased[store].score;
    scores[store] = ollamaAvailable
      ? clampScore(ruleScore * weights.ruleBased + ollama.scores[store] * weights.ollama)
      : ruleScore;
  });

  if (!ollamaAvailable) {
    warnings.push(
      `Ollama unavailable — using rule-based fallback.${ollama && ollama.error ? ` (${ollama.error})` : ""}`,
    );
  }

  const ruleRecommendation = topStore(
    Object.fromEntries(STORE_KEYS.map((store) => [store, ruleBased[store].score])),
  );
  const ollamaRecommendation = ollamaAvailable ? topStore(ollama.scores) : null;
  const recommendation = topStore(scores);

  // Disagreement handling: never silently pick one — surface both
  // recommendations and explain that the weighted hybrid score below
  // is what actually decided the outcome.
  const agreement = ollamaAvailable ? ruleRecommendation === ollamaRecommendation : true;

  if (ollamaAvailable && !agreement) {
    warnings.push(
      `Rule-based analysis recommends "${ruleRecommendation}" while Ollama recommends "${ollamaRecommendation}"; ` +
        `the weighted hybrid score (${weights.ruleBased * 100}% rule-based / ${weights.ollama * 100}% Ollama) below was used to produce the final recommendation.`,
    );
  }

  const reasons = [
    ...ruleBased[recommendation].reasons.map((reason) => `[Rule-based] ${reason}`),
    ...(ollamaAvailable ? ollama.reasons.map((reason) => `[Ollama] ${reason}`) : []),
  ];

  return {
    weights,
    scores,
    recommendation,
    confidence: scores[recommendation],
    agreement,
    ruleBasedRecommendation: ruleRecommendation,
    ollamaRecommendation,
    reasons,
    warnings,
  };
}

// ------------------------------------------------------------
// Main entry point (used by POST /analysis/store in server.js)
// ------------------------------------------------------------
async function analyzeStore({
  rows = [],
  originalName = "",
  profile,
  callOllamaFn,
  buildPromptFn,
} = {}) {
  // eslint-disable-next-line global-require
  const { profileDataset } = require("./data-profiler");
  const resolvedProfile = profile || profileDataset(rows, originalName, {});

  const metadata = buildDatasetMetadata(resolvedProfile, rows);
  const relationships = analyzeRelationships({ profile: resolvedProfile });
  const ruleBased = ruleBasedStoreAnalysis({ profile: resolvedProfile, relationships, originalName, rows });
  const ollama = await ollamaStoreAnalysis({
    metadata,
    relationships,
    originalName,
    callOllamaFn,
    buildPromptFn,
  });
  const hybrid = buildHybridDecision({ ruleBased, ollama });

  const warnings = [...(resolvedProfile.warnings || []), ...hybrid.warnings];

  return { metadata, relationships, ruleBased, ollama, hybrid, warnings };
}

module.exports = {
  STORE_KEYS,
  analyzeStore,
  buildDatasetMetadata,
  analyzeRelationships,
  ruleBasedStoreAnalysis,
  ollamaStoreAnalysis,
  interpretStoreAnalysisResponse,
  buildHybridDecision,

  // exported for unit testing
  computeDatasetNestedDepth,
  computeTextStats,
  detectRepeatedStructures,
  clampScore,
};
