/*
 * Input validation for the public API. Everything the client sends is
 * checked here BEFORE it gets anywhere near an adapter, and adapters
 * additionally only ever receive identifiers that passed these checks.
 */
const { badRequest } = require("./errors");
const { getConfig } = require("./config");

const COLLECTION_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const PROJECT_ID = /^proj_[0-9a-f]{12}$/;
const KEY_ID = /^[0-9a-f]{12}$/;
const FIELD_SEGMENT = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_DEPTH = 8;
const MAX_FILTERS = 20;
const MAX_IN_VALUES = 100;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RESERVED_COLLECTIONS = new Set(["query", "system", "admin", "maestro", "usage", "projects", "collections", "data"]);
const STORE_TYPES = ["postgresql", "mongodb", "elasticsearch"];
const OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "in"];
const QUERY_TYPES = ["select", "search", "count"];

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function validateProjectName(name) {
  if (typeof name !== "string" || !name.trim()) throw badRequest("Project name is required.");
  const trimmed = name.trim();
  if (trimmed.length > 100) throw badRequest("Project name must be 100 characters or fewer.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(trimmed)) throw badRequest("Project name contains invalid characters.");
  return trimmed;
}

function validateProjectId(id) {
  if (typeof id !== "string" || !PROJECT_ID.test(id)) throw badRequest("Invalid project id.");
  return id;
}

function validateKeyId(id) {
  if (typeof id !== "string" || !KEY_ID.test(id)) throw badRequest("Invalid key id.");
  return id;
}

function validateCollectionName(name) {
  if (typeof name !== "string" || !COLLECTION_NAME.test(name)) {
    throw badRequest(
      "Invalid collection name. Use 1-48 characters: lowercase letters, digits and underscores, starting with a letter.",
    );
  }
  if (RESERVED_COLLECTIONS.has(name)) throw badRequest(`"${name}" is a reserved collection name.`);
  return name;
}

function validateDocumentId(id) {
  const asString = typeof id === "number" ? String(id) : id;
  if (typeof asString !== "string" || !DOC_ID.test(asString)) throw badRequest("Invalid document id.");
  return asString;
}

function validateFieldPath(path, { allowDotted = true } = {}) {
  if (typeof path !== "string" || !path) throw badRequest("Field names must be non-empty strings.");
  const segments = path.split(".");
  if (segments.length > 1 && !allowDotted) throw badRequest(`Invalid field name "${path}".`);
  if (segments.length > MAX_DEPTH) throw badRequest(`Field path "${path}" is too deep.`);
  for (const segment of segments) {
    if (!FIELD_SEGMENT.test(segment) || FORBIDDEN_KEYS.has(segment)) {
      throw badRequest(`Invalid field name "${path}". Use letters, digits and underscores, starting with a letter.`);
    }
  }
  return path;
}

// Deep-validates the keys/values of a document body.
function checkValue(value, depth, path) {
  if (depth > MAX_DEPTH) throw badRequest(`Document is nested too deeply at "${path}" (max ${MAX_DEPTH} levels).`);
  if (value === null) return;
  const t = typeof value;
  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (!Number.isFinite(value)) throw badRequest(`Field "${path}" must be a finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw badRequest(`Array at "${path}" is too large (max 1000 items).`);
    value.forEach((item, i) => checkValue(item, depth + 1, `${path}[${i}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (!FIELD_SEGMENT.test(key) || FORBIDDEN_KEYS.has(key)) {
        throw badRequest(`Invalid field name "${key}" at "${path || "(root)"}". Use letters, digits and underscores, starting with a letter.`);
      }
      checkValue(value[key], depth + 1, path ? `${path}.${key}` : key);
    }
    return;
  }
  throw badRequest(`Unsupported value type at "${path}".`);
}

// A document is a non-empty JSON object with safe keys and bounded size.
function validateDocument(data, { allowEmpty = false } = {}) {
  if (!isPlainObject(data)) throw badRequest('"data" must be a JSON object.');
  const keys = Object.keys(data);
  if (!keys.length && !allowEmpty) throw badRequest('"data" must contain at least one field.');
  if (keys.length > 200) throw badRequest("Documents may have at most 200 top-level fields.");
  checkValue(data, 0, "");
  const size = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (size > getConfig().maxDocumentBytes) {
    throw badRequest(`Document is too large (${size} bytes; max ${getConfig().maxDocumentBytes}).`);
  }
  return data;
}

function isScalar(v) {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

function checkFilterValue(operator, value, field) {
  if (operator === "in") {
    if (!Array.isArray(value) || !value.length || value.length > MAX_IN_VALUES || !value.every(isScalar)) {
      throw badRequest(`Filter "in" on "${field}" needs a non-empty array (max ${MAX_IN_VALUES}) of scalar values.`);
    }
    return;
  }
  if (!isScalar(value)) throw badRequest(`Filter on "${field}" must use a scalar value.`);
  if (["gt", "gte", "lt", "lte"].includes(operator) && (value === null || typeof value === "boolean")) {
    throw badRequest(`Operator "${operator}" on "${field}" needs a number or string.`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw badRequest(`Filter on "${field}" must be finite.`);
  if (typeof value === "string" && value.length > 1000) throw badRequest(`Filter value for "${field}" is too long.`);
}

/*
 * Normalises filters into [{ field, operator, value }].
 * Accepted shapes:
 *   { category: "electronics" }                   -> eq
 *   { price: { gte: 10, lt: 100 }, tag: {in: []} } -> operator objects
 *   [{ field, operator, value }]                  -> explicit list
 * Operator keys come from a fixed allow-list; nothing client-supplied is
 * ever used as an operator or identifier unchecked.
 */
function normalizeFilters(raw) {
  if (raw === undefined || raw === null) return [];
  const out = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isPlainObject(item)) throw badRequest("Each filter must be an object { field, operator, value }.");
      const operator = item.operator === undefined ? "eq" : item.operator;
      if (!OPERATORS.includes(operator)) throw badRequest(`Unsupported filter operator "${operator}".`);
      validateFieldPath(item.field);
      checkFilterValue(operator, item.value, item.field);
      out.push({ field: item.field, operator, value: item.value });
    }
  } else if (isPlainObject(raw)) {
    for (const [field, spec] of Object.entries(raw)) {
      validateFieldPath(field);
      if (isPlainObject(spec)) {
        const ops = Object.entries(spec);
        if (!ops.length) throw badRequest(`Filter on "${field}" has no operators.`);
        for (const [operator, value] of ops) {
          if (!OPERATORS.includes(operator)) throw badRequest(`Unsupported filter operator "${operator}" on "${field}".`);
          checkFilterValue(operator, value, field);
          out.push({ field, operator, value });
        }
      } else {
        checkFilterValue("eq", spec, field);
        out.push({ field, operator: "eq", value: spec });
      }
    }
  } else {
    throw badRequest('"filters" must be an object or an array.');
  }
  if (out.length > MAX_FILTERS) throw badRequest(`Too many filters (max ${MAX_FILTERS}).`);
  return out;
}

function parseIntParam(value, name, { min, max, fallback }) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`"${name}" must be an integer between ${min} and ${max}.`);
  return n;
}

function normalizeSort(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  let field;
  let direction = "asc";
  if (typeof raw === "string") {
    // "price" or "-price" or "price:desc"
    if (raw.startsWith("-")) { direction = "desc"; field = raw.slice(1); }
    else if (raw.includes(":")) { [field, direction] = raw.split(":"); }
    else field = raw;
  } else if (isPlainObject(raw)) {
    field = raw.field;
    direction = raw.direction || "asc";
  } else throw badRequest('"sort" must be a string or { field, direction }.');
  direction = String(direction).toLowerCase();
  if (!["asc", "desc"].includes(direction)) throw badRequest('Sort direction must be "asc" or "desc".');
  validateFieldPath(field);
  return { field, direction };
}

/*
 * Validates a /v1/query (or GET list) request into a normalised spec.
 * `physical` database/index/table names are deliberately NOT accepted.
 */
function validateQueryRequest(body = {}) {
  const cfg = getConfig();
  if (!isPlainObject(body)) throw badRequest("Request body must be a JSON object.");
  const collection = validateCollectionName(body.collection);
  const queryType = body.queryType === undefined ? "select" : body.queryType;
  if (!QUERY_TYPES.includes(queryType)) throw badRequest(`queryType must be one of: ${QUERY_TYPES.join(", ")}.`);
  const filters = normalizeFilters(body.filters !== undefined ? body.filters : body.conditions);
  let text = null;
  let fields = [];
  if (queryType === "search") {
    if (typeof body.text !== "string" || !body.text.trim()) throw badRequest('Search queries need a non-empty "text".');
    if (body.text.length > 500) throw badRequest("Search text is too long (max 500 characters).");
    text = body.text.trim();
    if (body.fields !== undefined) {
      if (!Array.isArray(body.fields) || body.fields.length > 20) throw badRequest('"fields" must be an array of at most 20 field names.');
      fields = body.fields.map((f) => validateFieldPath(f));
    }
  }
  return {
    collection,
    queryType,
    filters,
    text,
    fields,
    sort: normalizeSort(body.sort),
    limit: parseIntParam(body.limit, "limit", { min: 1, max: cfg.maxQueryLimit, fallback: cfg.defaultQueryLimit }),
    offset: parseIntParam(body.offset, "offset", { min: 0, max: 1000000, fallback: 0 }),
  };
}

module.exports = {
  STORE_TYPES, OPERATORS, QUERY_TYPES, COLLECTION_NAME, PROJECT_ID,
  isPlainObject, validateProjectName, validateProjectId, validateKeyId, validateCollectionName,
  validateDocumentId, validateFieldPath, validateDocument, normalizeFilters, normalizeSort,
  validateQueryRequest, parseIntParam,
};
