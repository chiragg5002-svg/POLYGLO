/*
 * Bulk-import parsing, validation and profiling for POST /v1/import.
 *
 * - CSV is parsed with an incremental, quote-aware state machine over a
 *   read stream (rows are produced as they are parsed, never the whole
 *   file as one string). NDJSON is streamed line by line. A plain JSON
 *   array has to be parsed in one piece, which is why uploads are capped
 *   (MAESTRO_MAX_IMPORT_BYTES).
 * - Headers are normalised to safe snake_case field names; duplicates get
 *   a numeric suffix. The original -> normalised mapping is reported.
 * - Cell types are inferred conservatively: leading-zero numbers ("007"),
 *   very long digit strings and anything non-finite stay strings.
 * - Malformed rows become row-level errors, never a silent drop.
 */
const fs = require("fs");
const { badRequest } = require("./errors");
const V = require("./validators");

const MAX_ROW_ERRORS_REPORTED = 100;
const NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d{1,15})?([eE][+-]?\d{1,3})?$/;

function inferCell(raw) {
  const v = raw.trim();
  if (v === "") return null;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
  if (NUMBER.test(v)) { const n = Number(v); if (Number.isFinite(n)) return n; }
  return raw; // keep original text (including surrounding spaces) for strings
}

function normalizeHeader(raw, index) {
  let h = String(raw == null ? "" : raw).replace(/^\uFEFF/, "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!h) h = `column_${index + 1}`;
  if (!/^[a-z]/.test(h)) h = `f_${h}`;
  return h.slice(0, 63);
}

function normalizeHeaders(rawHeaders) {
  const used = new Set();
  const mapping = [];
  const names = rawHeaders.map((raw, i) => {
    const base = normalizeHeader(raw, i);
    let name = base;
    let n = 1;
    while (used.has(name)) { n += 1; name = `${base.slice(0, 58)}_${n}`; }
    used.add(name);
    mapping.push({ original: String(raw), field: name });
    return name;
  });
  return { names, mapping };
}

// Incremental CSV tokenizer: feed(string) / end() -> rows as string[][].
class CsvTokenizer {
  constructor(delimiter) {
    this.d = delimiter; this.field = ""; this.row = []; this.inQuotes = false;
    this.afterQuote = false; this.rows = []; this.line = 1; this.rowStartLine = 1; this.unterminated = false;
  }
  feed(text) {
    let start = 0;
    if (this.quotePending) {
      // A closing-quote candidate was the last char of the previous chunk.
      this.quotePending = false;
      if (text[0] === '"') { this.field += '"'; start = 1; } else { this.inQuotes = false; this.afterQuote = true; }
    }
    for (let i = start; i < text.length; i += 1) {
      const c = text[i];
      if (this.inQuotes) {
        if (c === '"') {
          if (i + 1 >= text.length) { this.quotePending = true; } // decide on the next chunk
          else if (text[i + 1] === '"') { this.field += '"'; i += 1; }
          else { this.inQuotes = false; this.afterQuote = true; }
        } else { if (c === "\n") this.line += 1; this.field += c; }
        continue;
      }
      if (c === '"' && this.field === "" && !this.afterQuote) { this.inQuotes = true; continue; }
      if (c === this.d) { this.row.push(this.field); this.field = ""; this.afterQuote = false; continue; }
      if (c === "\r") continue;
      if (c === "\n") { this.endRow(); this.line += 1; continue; }
      this.field += c; // includes stray text after a closing quote: kept, not dropped
    }
  }
  endRow() {
    this.row.push(this.field);
    const blank = this.row.length === 1 && this.row[0] === "";
    if (!blank) this.rows.push({ cells: this.row, line: this.rowStartLine });
    this.field = ""; this.row = []; this.afterQuote = false; this.rowStartLine = this.line + 1;
  }
  end() {
    if (this.quotePending) { this.quotePending = false; this.inQuotes = false; this.afterQuote = true; }
    if (this.inQuotes) this.unterminated = true;
    if (this.field !== "" || this.row.length) this.endRow();
  }
  drain() { const r = this.rows; this.rows = []; return r; }
}

function detectDelimiter(sample, filename) {
  if (/\.tsv$/i.test(filename || "")) return "\t";
  const firstLine = sample.split(/\r?\n/, 1)[0] || "";
  const count = (ch) => (firstLine.match(new RegExp(`\\${ch}`, "g")) || []).length;
  return count("\t") > count(",") ? "\t" : ",";
}

/*
 * Streams records out of an upload. Yields { row, data } for good rows and
 * { row, error } for rows that could not be turned into a record. `row` is
 * 1-based and refers to the data row (header excluded) / record number.
 */
async function* readRecords(filePath, filename, { maxRows, meta = {} }) {
  const lower = String(filename || "").toLowerCase();
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  let emitted = 0;
  const guard = () => { if (emitted > maxRows) throw Object.assign(badRequest(`File has more than the allowed ${maxRows} rows.`), { status: 413, code: "import_too_large" }); };

  if (lower.endsWith(".ndjson") || lower.endsWith(".jsonl")) {
    let buffer = ""; let lineNo = 0;
    const handle = function* (line) {
      lineNo += 1;
      if (!line.trim()) return;
      emitted += 1; guard();
      try {
        const obj = JSON.parse(line);
        if (!V.isPlainObject(obj)) yield { row: lineNo, error: "Line is not a JSON object." };
        else yield { row: lineNo, data: obj };
      } catch (e) { yield { row: lineNo, error: "Line is not valid JSON." }; }
    };
    for await (const chunk of stream) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1); yield* handle(line); }
    }
    if (buffer) yield* handle(buffer);
    return;
  }

  if (lower.endsWith(".json")) {
    let text = "";
    for await (const chunk of stream) text += chunk;
    let parsed;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (e) { throw badRequest("File is not valid JSON."); }
    const arr = Array.isArray(parsed) ? parsed : V.isPlainObject(parsed) && Array.isArray(parsed.records) ? parsed.records : null;
    if (!arr) throw badRequest('JSON must be an array of objects (or { "records": [...] }).');
    for (let i = 0; i < arr.length; i += 1) {
      emitted += 1; guard();
      if (V.isPlainObject(arr[i])) yield { row: i + 1, data: arr[i] };
      else yield { row: i + 1, error: "Record is not a JSON object." };
    }
    return;
  }

  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
    let tok = null; let names = null; let rawHeaders = null; let rowNo = 0; let first = true;
    const emitRows = function* (rows) {
      for (const { cells, line } of rows) {
        if (!names) {
          const { names: n, mapping } = normalizeHeaders(cells);
          names = n; rawHeaders = cells; meta.mapping = mapping;
          continue;
        }
        rowNo += 1; emitted += 1; guard();
        if (cells.length !== names.length) { yield { row: rowNo, line, error: `Expected ${names.length} columns but found ${cells.length}.` }; continue; }
        const data = {};
        names.forEach((n, i) => { data[n] = inferCell(cells[i]); });
        yield { row: rowNo, line, data };
      }
    };
    for await (let chunk of stream) {
      if (first) { first = false; chunk = chunk.replace(/^\uFEFF/, ""); tok = new CsvTokenizer(detectDelimiter(chunk, lower)); }
      tok.feed(chunk);
      yield* emitRows(tok.drain());
    }
    if (tok) {
      tok.end();
      yield* emitRows(tok.drain());
      if (tok.unterminated) yield { row: rowNo + 1, error: "File ends inside an unterminated quoted field." };
    }
    if (!names) throw badRequest("The file is empty or has no header row.");
    return;
  }
  throw badRequest("Unsupported file type. Use .csv, .tsv, .json or .ndjson.");
}

// ---------------------------------------------------------------- profiling
const SENSITIVE_NAME = /(pass(word|wd)?|secret|token|api[_-]?key|ssn|social_?security|credit|card|cvv|iban|account_?number|dob|birth|email|phone|mobile|address|passport|license|salary|aadhaar|pan_?number)/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function luhn(digits) {
  let sum = 0; let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

class FieldProfiler {
  constructor() { this.fields = new Map(); this.rows = 0; }
  add(doc) {
    this.rows += 1;
    for (const [k, v] of Object.entries(doc)) {
      let f = this.fields.get(k);
      if (!f) { f = { types: {}, nulls: 0, distinct: new Set(), distinctCapped: false, samples: [], emailLike: 0, cardLike: 0 }; this.fields.set(k, f); }
      const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
      f.types[t] = (f.types[t] || 0) + 1;
      if (v === null) f.nulls += 1;
      if (typeof v === "string") {
        if (EMAIL.test(v)) f.emailLike += 1;
        const digits = v.replace(/[\s-]/g, "");
        if (/^\d{13,19}$/.test(digits) && luhn(digits)) f.cardLike += 1;
      }
      if (v !== null && typeof v !== "object") {
        if (f.distinct.size < 1000) f.distinct.add(v); else f.distinctCapped = true;
      }
    }
  }
  report() {
    const fields = []; const warnings = [];
    for (const [name, f] of this.fields) {
      const present = Object.values(f.types).reduce((a, b) => a + b, 0);
      const missing = this.rows - present;
      const sensitive = SENSITIVE_NAME.test(name) || f.emailLike / Math.max(1, present) > 0.5 || f.cardLike > 0;
      if (sensitive) warnings.push(`Field "${name}" looks like sensitive data (PII/credentials). Consider whether it should be stored.`);
      fields.push({
        name, types: f.types, nullRate: round((f.nulls + missing) / Math.max(1, this.rows)),
        distinctValues: f.distinctCapped ? `>${f.distinct.size - 1}` : f.distinct.size,
        // Never echo sample values of fields that look sensitive.
        sampleValues: sensitive ? ["[withheld]"] : [...f.distinct].slice(0, 3),
        sensitive,
      });
    }
    return { rows: this.rows, fields, warnings };
  }
}
const round = (n) => Math.round(n * 1000) / 1000;

module.exports = { readRecords, normalizeHeaders, inferCell, FieldProfiler, MAX_ROW_ERRORS_REPORTED, CsvTokenizer };
