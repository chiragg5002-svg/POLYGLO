const fs = require("fs");

/*
 * ============================================================
 * MAESTRO data profiler
 * ============================================================
 *
 * Turns a raw CSV/TSV/JSON upload into a consistent profiling
 * result (see the "PROFILE RESULT SHAPE" doc block near the
 * bottom of this file, and API_PROFILING.md, for the exact
 * schema). Used by POST /profile in server.js; nothing else in
 * the app depends on this module.
 *
 * Design goals:
 *   - never throw on merely "weird" data (empty files, ragged
 *     CSV rows, mixed types, missing fields) — only throw
 *     (ProfilingValidationError) when the input truly cannot be
 *     interpreted as tabular/document data at all (invalid JSON,
 *     a CSV with no header row, an unsupported extension).
 *   - be honest about nested JSON (objects/arrays) instead of
 *     silently stringifying them into "Text".
 *   - flag likely mixed-type columns instead of quietly folding
 *     them into "Text".
 */

// Thrown for inputs that can't be profiled at all. server.js maps
// this to a 400 response; anything else stays a 500 (see the
// /profile route).
class ProfilingValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProfilingValidationError";
  }
}

// ------------------------------------------------------------
// Value-level helpers
// ------------------------------------------------------------

function isNestedValue(value) {
  return value !== null && typeof value === "object";
}

// Safe to use as a dedupe/uniqueness key for ANY value, including
// nested objects/arrays — String() on an array or object collapses
// distinct values together (e.g. every plain object stringifies to
// "[object Object]"), which silently wrecks uniqueValues/cardinality
// and sample-value dedupe for JSON data.
function stableStringify(value) {
  if (value === null || value === undefined) return "";
  if (isNestedValue(value)) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }
  return String(value);
}

function isMissing(value) {
  if (value === null || value === undefined) return true;
  // An empty array/object is a real, present value (e.g. "no tags
  // yet"), not a missing one — only primitives can be blank strings.
  if (isNestedValue(value)) return false;
  return String(value).trim() === "";
}

function isBoolean(value) {
  if (isNestedValue(value)) return false;
  if (typeof value === "boolean") return true;

  const text = String(value).trim().toLowerCase();

  return text === "true" || text === "false";
}

function isNumber(value) {
  if (isMissing(value)) return false;
  // Guard explicitly against JS's `Number()` coercion quirks on
  // arrays/objects (e.g. Number([5]) === 5, Number([]) === 0), which
  // would otherwise misclassify single-element numeric arrays.
  if (isNestedValue(value)) return false;
  if (isBoolean(value)) return false;

  const num = Number(value);

  return Number.isFinite(num);
}

// JS's `new Date()` constructor is dangerously lenient — e.g.
// `new Date("C-1001")` silently parses as the year 1001, which would
// make any "C-1001"-style ID column look like a date column. Only
// hand a string to `new Date()` if it already looks like one of
// these common date/datetime formats.
const DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/, // ISO date / datetime
  /^\d{4}\/\d{2}\/\d{2}$/, // YYYY/MM/DD
  /^\d{1,2}\/\d{1,2}\/\d{4}$/, // MM/DD/YYYY or DD/MM/YYYY
  /^\d{1,2}-\d{1,2}-\d{4}$/, // DD-MM-YYYY or MM-DD-YYYY
  /^\d{4}-\d{2}$/, // YYYY-MM
  /^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}$/, // January 5, 2024 / Jan 5 2024
  /^\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}$/, // 5 January 2024
];

function looksLikeDate(text) {
  return DATE_PATTERNS.some((pattern) => pattern.test(text));
}

function isDate(value) {
  if (isMissing(value)) return false;
  if (isNestedValue(value)) return false;
  if (isBoolean(value)) return false;

  const text = String(value).trim();

  if (!looksLikeDate(text)) {
    return false;
  }

  const date = new Date(text);

  return !Number.isNaN(date.getTime());
}

// ------------------------------------------------------------
// Column type detection
// ------------------------------------------------------------
// Returns one of: "Unknown", "Object", "Array", "Nested" (a mix of
// objects and arrays in the same column), "Boolean", "Numeric",
// "Date", "Mixed" (a real blend of the above with no clear
// majority), or "Text" (the default/fallback).
function detectType(values) {
  const valid = values.filter((value) => !isMissing(value));

  if (valid.length === 0) {
    return "Unknown";
  }

  // Nested JSON (objects/arrays) takes priority: if most present
  // values in this column are objects/arrays, that IS the type,
  // regardless of what any stringified leftovers might look like.
  const nestedValues = valid.filter(isNestedValue);

  if (nestedValues.length / valid.length >= 0.5) {
    const arrayCount = nestedValues.filter((value) => Array.isArray(value)).length;

    if (arrayCount === nestedValues.length) return "Array";
    if (arrayCount === 0) return "Object";
    return "Nested";
  }

  const booleanCount = valid.filter(isBoolean).length;

  if (booleanCount / valid.length >= 0.95) {
    return "Boolean";
  }

  const numericCount = valid.filter(isNumber).length;

  if (numericCount / valid.length >= 0.95) {
    return "Numeric";
  }

  const dateCount = valid.filter(isDate).length;

  if (dateCount / valid.length >= 0.95) {
    return "Date";
  }

  // None of boolean/numeric/date dominates on its own. If a
  // meaningful blend of them is present (rather than this simply
  // being free-form text), call it out explicitly as "Mixed" so a
  // caller doesn't mistake it for clean text data.
  const typedCount = booleanCount + numericCount + dateCount;
  const distinctTypesPresent = [booleanCount, numericCount, dateCount].filter(
    (count) => count > 0,
  ).length;

  if (distinctTypesPresent >= 2 && typedCount / valid.length >= 0.5) {
    return "Mixed";
  }

  return "Text";
}

function isNestedType(type) {
  return type === "Object" || type === "Array" || type === "Nested";
}

// ------------------------------------------------------------
// Sample values
// ------------------------------------------------------------
const MAX_SAMPLE_VALUES = 5;

function computeSampleValues(values, limit = MAX_SAMPLE_VALUES) {
  const seen = new Set();
  const samples = [];

  for (const value of values) {
    if (isMissing(value)) continue;

    const key = stableStringify(value);
    if (seen.has(key)) continue;

    seen.add(key);
    samples.push(value);

    if (samples.length >= limit) break;
  }

  return samples;
}

// ------------------------------------------------------------
// Quality / numeric / date / boolean stats
// ------------------------------------------------------------

function calculateQuality(missingPercentage) {
  if (missingPercentage === 0) {
    return "EXCELLENT";
  }

  if (missingPercentage <= 5) {
    return "GOOD";
  }

  if (missingPercentage <= 20) {
    return "FAIR";
  }

  return "POOR";
}

function standardDeviation(numbers, mean) {
  if (numbers.length < 2) {
    return 0;
  }

  const variance =
    numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    numbers.length;

  return Math.sqrt(variance);
}

function detectNumericPattern(numbers) {
  if (numbers.length < 3) {
    return "INSUFFICIENT_DATA";
  }

  const sorted = [...numbers].sort((a, b) => a - b);

  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;

  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];

  const stdDev = standardDeviation(sorted, mean);

  if (stdDev === 0) {
    return "ROUGHLY-SYMMETRIC";
  }

  const skew = (mean - median) / stdDev;

  if (skew > 0.2) {
    return "RIGHT-SKEWED";
  }

  if (skew < -0.2) {
    return "LEFT-SKEWED";
  }

  return "ROUGHLY-SYMMETRIC";
}

function profileNumeric(values) {
  const numbers = values.filter(isNumber).map(Number);

  if (!numbers.length) {
    return {};
  }

  const sum = numbers.reduce((a, b) => a + b, 0);
  const mean = sum / numbers.length;

  const sorted = [...numbers].sort((a, b) => a - b);

  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];

  return {
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    average: Number(mean.toFixed(4)),
    median,
    stdDev: Number(standardDeviation(numbers, mean).toFixed(4)),
    pattern: detectNumericPattern(numbers),
  };
}

function profileDate(values) {
  const dates = values
    .filter(isDate)
    .map((value) => new Date(value))
    .sort((a, b) => a - b);

  if (!dates.length) {
    return {};
  }

  const earliest = dates[0];
  const latest = dates[dates.length - 1];

  const days = Math.round((latest - earliest) / (1000 * 60 * 60 * 24));

  return {
    earliestDate: earliest.toISOString().split("T")[0],
    latestDate: latest.toISOString().split("T")[0],
    timeSpanDays: days,
    pattern: "TEMPORAL",
  };
}

function profileBoolean(values) {
  const bools = values
    .filter(isBoolean)
    .map((value) =>
      typeof value === "boolean"
        ? value
        : String(value).trim().toLowerCase() === "true",
    );

  if (!bools.length) {
    return {};
  }

  const trueCount = bools.filter(Boolean).length;

  return {
    trueCount,
    falseCount: bools.length - trueCount,
    truePercentage: Number(((trueCount / bools.length) * 100).toFixed(2)),
  };
}

// ------------------------------------------------------------
// Per-column profiling
// ------------------------------------------------------------

function profileColumn(rows, columnName) {
  const values = rows.map((row) => (row ? row[columnName] : undefined));

  const totalRows = rows.length;

  const missingCount = values.filter(isMissing).length;

  const validValues = values.filter((value) => !isMissing(value));

  // stableStringify (not String()) so distinct nested objects/arrays
  // don't all collapse into the same "[object Object]" bucket.
  const uniqueValues = new Set(validValues.map(stableStringify));

  const missingPercentage =
    totalRows === 0 ? 0 : Number(((missingCount / totalRows) * 100).toFixed(2));

  const type = detectType(values);
  const nested = isNestedType(type);

  const result = {
    column: columnName,
    type,
    totalValues: totalRows,
    missingCount,
    missingPercentage,
    uniqueValues: uniqueValues.size,
    cardinality: totalRows
      ? Number((uniqueValues.size / totalRows).toFixed(4))
      : 0,
    quality: calculateQuality(missingPercentage),
    isNested: nested,
    nestedType: nested ? (type === "Nested" ? "mixed" : type.toLowerCase()) : null,
    sampleValues: computeSampleValues(values),
  };

  if (type === "Numeric") {
    Object.assign(result, profileNumeric(values));
  }

  if (type === "Date") {
    Object.assign(result, profileDate(values));
  }

  if (type === "Boolean") {
    Object.assign(result, profileBoolean(values));
  }

  return result;
}

// ------------------------------------------------------------
// Dataset-level pattern detection
// ------------------------------------------------------------
// Mirrors the deterministic rules already used for routing in
// server.js (/routing/recommend) and database-service.js
// (inferRoutingRecommendation), so a dataset gets the same read
// whether it's being profiled or routed.
const LOG_FIELDS = ["timestamp", "level", "message", "service", "log", "event"];
const TRANSACTIONAL_REGEX = /order|customer|invoice|payment|user|account/i;
const SEARCH_REGEX = /title|content|description|text|search|article|document/i;

function emptyDatasetPatterns() {
  return {
    nestedDocument: { matched: false, reason: "" },
    searchLog: { matched: false, reason: "" },
    timeSeries: { matched: false, reason: "" },
    transactional: { matched: false, reason: "" },
    tabular: { matched: false, reason: "" },
    primary: "unknown",
  };
}

function detectDatasetPatterns({ rows, columns, format, originalName }) {
  if (!rows.length || !columns.length) {
    return emptyDatasetPatterns();
  }

  const patterns = emptyDatasetPatterns();
  delete patterns.primary;

  const columnNames = columns.map((column) => column.column.toLowerCase());
  const hasNestedData = columns.some((column) => column.isNested);
  const sampleText = JSON.stringify(rows.slice(0, 5)).toLowerCase();

  // 1. Nested document data
  if (format === "json" && hasNestedData) {
    patterns.nestedDocument = {
      matched: true,
      reason:
        "One or more fields contain nested objects or arrays, which fits a document store like MongoDB.",
    };
  }

  // 2. Search / log data
  const matchedLogFields = LOG_FIELDS.filter((field) => columnNames.includes(field));
  const isSearchHeavy =
    SEARCH_REGEX.test(sampleText) ||
    String(originalName || "").toLowerCase().includes("search");

  if (matchedLogFields.length >= 2) {
    patterns.searchLog = {
      matched: true,
      reason: `Log-oriented fields present (${matchedLogFields.join(", ")}), suggesting search/log-style data.`,
    };
  } else if (isSearchHeavy) {
    patterns.searchLog = {
      matched: true,
      reason:
        "Search-oriented text fields (title/content/description/article/document) suggest search-style data.",
    };
  }

  // 3. Time-series data: a Date column with real spread, alongside
  // at least one numeric measurement column.
  const dateColumn = columns.find(
    (column) => column.type === "Date" && typeof column.timeSpanDays === "number",
  );
  const numericColumn = columns.find((column) => column.type === "Numeric");

  if (dateColumn && numericColumn && rows.length >= 3) {
    patterns.timeSeries = {
      matched: true,
      reason: `"${dateColumn.column}" is a date field spanning ${dateColumn.timeSpanDays} day(s) alongside numeric field "${numericColumn.column}", suggesting time-series data.`,
    };
  }

  // 4. Transactional data
  const isTransactional =
    TRANSACTIONAL_REGEX.test(sampleText) || TRANSACTIONAL_REGEX.test(columnNames.join(" "));

  if (isTransactional && numericColumn) {
    patterns.transactional = {
      matched: true,
      reason:
        "Order/customer/invoice/payment/account-style fields combined with numeric values suggest transactional records.",
    };
  }

  // 5. Tabular data — the flat/rectangular default shape
  if (!hasNestedData) {
    patterns.tabular = {
      matched: true,
      reason:
        format === "csv" || format === "tsv"
          ? "Delimited (CSV/TSV) data is inherently flat/tabular."
          : "JSON data has no nested objects or arrays, so it fits a flat/tabular shape.",
    };
  }

  const precedence = ["nestedDocument", "searchLog", "timeSeries", "transactional", "tabular"];
  const primary = precedence.find((key) => patterns[key].matched) || "tabular";

  return { ...patterns, primary };
}

// ------------------------------------------------------------
// Row normalization
// ------------------------------------------------------------
// A JSON upload doesn't have to be an array of plain objects — it
// could be an array of arrays, an array of primitives, or a single
// object. Rather than crashing or silently dropping such rows, wrap
// anything that isn't a plain object into a single `value` column so
// it can still be profiled and the caller is told this happened.
function normalizeRows(rows) {
  let wrappedCount = 0;

  const normalized = rows.map((row) => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      return row;
    }

    wrappedCount += 1;
    return { value: row };
  });

  return { normalized, wrappedCount };
}

function detectFormatFromName(originalName = "") {
  const lower = String(originalName || "").toLowerCase();

  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".tsv")) return "tsv";
  if (lower.endsWith(".csv")) return "csv";

  return "unknown";
}

// ------------------------------------------------------------
// Dataset-level profiling
// ------------------------------------------------------------

function profileDataset(rows, originalName = "", options = {}) {
  if (!Array.isArray(rows)) {
    throw new ProfilingValidationError("Dataset must be an array of objects.");
  }

  const format = options.format || detectFormatFromName(originalName);

  if (rows.length === 0) {
    return {
      dataset: originalName,
      format,
      isEmpty: true,
      rowCount: 0,
      columnCount: 0,
      columns: [],
      hasNestedData: false,
      datasetPatterns: emptyDatasetPatterns(),
      warnings: options.warnings ? [...options.warnings] : [],
    };
  }

  const { normalized: normalizedRows, wrappedCount } = normalizeRows(rows);

  const columnSet = new Set();

  normalizedRows.forEach((row) => {
    Object.keys(row).forEach((key) => columnSet.add(key));
  });

  const columns = [...columnSet];
  const profiles = columns.map((column) => profileColumn(normalizedRows, column));
  const hasNestedData = profiles.some((column) => column.isNested);

  const datasetPatterns = detectDatasetPatterns({
    rows: normalizedRows,
    columns: profiles,
    format,
    originalName,
  });

  const warnings = options.warnings ? [...options.warnings] : [];

  if (wrappedCount > 0) {
    warnings.push(
      `${wrappedCount} row(s) were not JSON objects (e.g. plain arrays or primitive values) and were wrapped into a single "value" column so they could still be profiled.`,
    );
  }

  return {
    dataset: originalName,
    format,
    isEmpty: false,
    rowCount: rows.length,
    columnCount: columns.length,
    columns: profiles,
    hasNestedData,
    datasetPatterns,
    warnings,
  };
}

// ------------------------------------------------------------
// CSV / TSV parser
// ------------------------------------------------------------
// Supports comma- and tab-separated files with RFC4180-style
// quoting: quoted fields, delimiters inside quotes, and doubled
// quotes ("") as an escaped quote. Known limitation: a quoted field
// containing a literal newline is not supported, since rows are
// split on line breaks before quote parsing begins.
function splitCsvLine(line, delimiter) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

function parseCsv(contents) {
  if (typeof contents !== "string") {
    throw new ProfilingValidationError("CSV content must be a string.");
  }

  const lines = contents
    .replace(/^\uFEFF/, "") // strip a UTF-8 BOM if present
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());

  if (lines.length === 0) {
    return [];
  }

  // Detect delimiter automatically
  const firstLine = lines[0];

  const delimiter = firstLine.includes("\t") ? "\t" : ",";

  const headers = splitCsvLine(firstLine, delimiter).map((header) => header.trim());

  if (headers.every((header) => header === "")) {
    throw new ProfilingValidationError("CSV file has no column headers.");
  }

  // Auto-name blank headers and de-duplicate repeated ones so no two
  // columns silently collide/overwrite each other.
  const seenHeaders = new Set();

  headers.forEach((header, index) => {
    let name = header || `column_${index + 1}`;

    while (seenHeaders.has(name)) {
      name = `${name}_${index + 1}`;
    }

    seenHeaders.add(name);
    headers[index] = name;
  });

  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line, delimiter);

    const row = {};

    headers.forEach((header, index) => {
      const raw = values[index];
      row[header] = raw !== undefined ? raw.trim() : null;
    });

    return row;
  });
}

// ------------------------------------------------------------
// JSON parser
// ------------------------------------------------------------
function parseJson(contents) {
  if (typeof contents !== "string") {
    throw new ProfilingValidationError("JSON content must be a string.");
  }

  const trimmed = contents.trim();

  if (trimmed === "") {
    return [];
  }

  let parsed;

  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new ProfilingValidationError(`Invalid JSON file: ${error.message}`);
  }

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed && typeof parsed === "object") {
    return [parsed];
  }

  // A bare JSON primitive (e.g. `42`, `"hello"`, `true`) is valid
  // JSON but isn't a row/collection of rows on its own.
  return [{ value: parsed }];
}

// ------------------------------------------------------------
// Entry point used by server.js
// ------------------------------------------------------------

function profileFile(filePath, originalName = "") {
  if (!filePath) {
    throw new ProfilingValidationError("No file path was provided to profile.");
  }

  console.log(`Profiling file: ${originalName}`);

  let contents;

  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new ProfilingValidationError(`Unable to read uploaded file: ${error.message}`);
  }

  const format = detectFormatFromName(originalName);

  let rows;

  if (format === "json") {
    rows = parseJson(contents);
  } else if (format === "csv" || format === "tsv") {
    rows = parseCsv(contents);
  } else {
    throw new ProfilingValidationError("Only CSV, TSV and JSON files are supported.");
  }

  return profileDataset(rows, originalName, { format });
}

/*
 * ============================================================
 * PROFILE RESULT SHAPE (kept in sync with API_PROFILING.md)
 * ============================================================
 *
 * {
 *   dataset: string,               // originalName passed in
 *   format: "csv" | "tsv" | "json" | "unknown",
 *   isEmpty: boolean,
 *   rowCount: number,
 *   columnCount: number,
 *   hasNestedData: boolean,        // true if any column is Object/Array/Nested
 *   warnings: string[],            // non-fatal notes (ragged rows, wrapped primitives, ...)
 *   datasetPatterns: {
 *     nestedDocument: { matched: boolean, reason: string },
 *     searchLog:      { matched: boolean, reason: string },
 *     timeSeries:     { matched: boolean, reason: string },
 *     transactional:  { matched: boolean, reason: string },
 *     tabular:        { matched: boolean, reason: string },
 *     primary: "nestedDocument" | "searchLog" | "timeSeries" |
 *              "transactional" | "tabular" | "unknown",
 *   },
 *   columns: [
 *     {
 *       column: string,
 *       type: "Boolean" | "Numeric" | "Date" | "Text" | "Mixed" |
 *             "Object" | "Array" | "Nested" | "Unknown",
 *       totalValues: number,
 *       missingCount: number,
 *       missingPercentage: number,
 *       uniqueValues: number,
 *       cardinality: number,        // uniqueValues / totalValues
 *       quality: "EXCELLENT" | "GOOD" | "FAIR" | "POOR",
 *       isNested: boolean,
 *       nestedType: "object" | "array" | "mixed" | null,
 *       sampleValues: any[],        // up to 5 distinct, non-missing raw values
 *
 *       // type === "Numeric" only:
 *       min?: number, max?: number, average?: number, median?: number,
 *       stdDev?: number, pattern?: "RIGHT-SKEWED" | "LEFT-SKEWED" |
 *                                  "ROUGHLY-SYMMETRIC" | "INSUFFICIENT_DATA",
 *
 *       // type === "Date" only:
 *       earliestDate?: string, latestDate?: string, timeSpanDays?: number,
 *       pattern?: "TEMPORAL",
 *
 *       // type === "Boolean" only:
 *       trueCount?: number, falseCount?: number, truePercentage?: number,
 *     },
 *   ],
 * }
 */

module.exports = {
  // main entry points
  profileFile,
  profileDataset,
  profileColumn,

  // parsers
  parseCsv,
  parseJson,

  // type/value helpers (exported for unit testing)
  detectType,
  isMissing,
  isBoolean,
  isNumber,
  isDate,
  isNestedValue,
  isNestedType,
  looksLikeDate,
  stableStringify,
  computeSampleValues,

  // stats helpers (exported for unit testing)
  calculateQuality,
  standardDeviation,
  detectNumericPattern,
  profileNumeric,
  profileDate,
  profileBoolean,

  // pattern detection
  detectDatasetPatterns,
  detectFormatFromName,

  // errors
  ProfilingValidationError,
};
