/*
 * ============================================================
 * MAESTRO / POLYGLODB cross-database query federation (prototype)
 * ============================================================
 *
 * Powers POST /v1/query/federated. Builds on query-engine.js's
 * single-source execution (same dataset resolution, same
 * parameterized/whitelisted per-database query builders) and adds
 * exactly one capability on top: joining two independently-fetched
 * result sets in the application layer.
 *
 * Two-stage execution, always in this order:
 *   1. Run each source's query independently against its own
 *      database, with a hard cap on rows fetched (see
 *      MAX_SOURCE_ROWS) and an overall wall-clock timeout — nothing
 *      is pushed down to the other database, and no query ever scans
 *      an entire collection/table unbounded.
 *   2. Join or merge the two row sets in Node, using ONLY the join
 *      field(s) the client explicitly provided (see
 *      "Explicit join fields" below).
 *
 * ------------------------------------------------------------
 * THIS IS A SAFE PROTOTYPE, NOT PRODUCTION-GRADE FEDERATION.
 * ------------------------------------------------------------
 * Documented limitations (see also API_FEDERATION.md):
 *   - Exactly two sources per query (one join). No N-way joins yet.
 *   - Only "inner" and "left" joins. No right/full/cross joins.
 *   - The join happens entirely in memory after both sources are
 *     fetched — it is a hash join over whatever rows were fetched,
 *     not a database-level join. If a matching row exists on the
 *     "many" side but wasn't within the per-source row cap, it will
 *     silently not appear in the join result.
 *   - Join fields must be given explicitly by the client (see
 *     "Explicit join fields" below) — nothing is inferred from
 *     naming conventions or foreign-key metadata.
 *   - Filtering happens per-source, BEFORE the join. There is no
 *     post-join filtering/HAVING-style step in this prototype.
 *   - A MongoDB document whose identifier column was remapped to
 *     `_id` at import time (see database-service.js) can only be
 *     joined on by its original field name if that value is also
 *     readable as `_id` — getJoinValue() falls back to `_id` when
 *     the named field is absent, but this is a best-effort shim, not
 *     a guarantee the semantics match a real relational join.
 *
 * Explicit join fields: `join.left.field` / `join.right.field` are
 * required in every request. This module never guesses a join key
 * from column names or from any "related dataset" metadata — the
 * only use of metadata here is to (a) resolve each dataset name to
 * its actual database/table/collection, the same as query-engine.js
 * does for a single-source query, and (b) sanity-check that the
 * given join field actually exists in a dataset's recorded schema
 * when that schema is known (PostgreSQL always has one; MongoDB/
 * Elasticsearch imports may not, in which case this check is skipped
 * rather than blocking a legitimately schemaless join).
 */

const {
  QueryValidationError,
  ALLOWED_TARGET_DATABASES,
  normalizeFilterConditions,
  normalizeSchema,
  resolveDatasetLocation,
  runPostgresQuery,
  runMongoQuery,
  runElasticsearchQuery,
} = require('./query-engine');
const { redactSensitive } = require('./redact');

class FederationValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FederationValidationError';
  }
}

const ALLOWED_JOIN_TYPES = ['inner', 'left'];
// v1 prototype: exactly one join between exactly two sources.
const REQUIRED_SOURCE_COUNT = 2;

// ------------------------------------------------------------
// Configurable limits (env-overridable, but always clamped to a
// hard ceiling in code — an env var alone cannot open up an
// uncontrolled full-database scan or an unbounded timeout).
// ------------------------------------------------------------
const ABSOLUTE_MAX_SOURCE_ROWS = 10000;
const ABSOLUTE_MAX_RESULT_ROWS = 5000;
const ABSOLUTE_MAX_TIMEOUT_MS = 60000;
const MIN_TIMEOUT_MS = 1000;

const MAX_SOURCE_ROWS = Math.min(Number(process.env.FEDERATION_MAX_SOURCE_ROWS) || 2000, ABSOLUTE_MAX_SOURCE_ROWS);
const DEFAULT_SOURCE_ROWS = Math.min(500, MAX_SOURCE_ROWS);
const DEFAULT_RESULT_ROWS = Math.min(Number(process.env.FEDERATION_DEFAULT_RESULT_ROWS) || 200, ABSOLUTE_MAX_RESULT_ROWS);
const MAX_RESULT_ROWS = Math.min(Number(process.env.FEDERATION_MAX_RESULT_ROWS) || 1000, ABSOLUTE_MAX_RESULT_ROWS);
const DEFAULT_TIMEOUT_MS = Math.min(Number(process.env.FEDERATION_TIMEOUT_MS) || 10000, ABSOLUTE_MAX_TIMEOUT_MS);

// ------------------------------------------------------------
// Request validation
// ------------------------------------------------------------

function validateJoinSide(side, label, knownAliases) {
  if (!side || typeof side !== 'object' || Array.isArray(side)) {
    throw new FederationValidationError(`"${label}" is required and must be an object with "alias" and "field".`);
  }
  const alias = typeof side.alias === 'string' ? side.alias.trim() : '';
  const field = typeof side.field === 'string' ? side.field.trim() : '';
  if (!alias) {
    throw new FederationValidationError(`"${label}.alias" is required.`);
  }
  if (!field) {
    throw new FederationValidationError(
      `"${label}.field" is required — join fields must be given explicitly, they are never inferred.`,
    );
  }
  if (!knownAliases.has(alias)) {
    throw new FederationValidationError(`"${label}.alias" ("${alias}") does not match any entry in "sources".`);
  }
  return { alias, field };
}

// Validates a full /v1/query/federated request body. Throws
// FederationValidationError (mapped to HTTP 400 by the route) for
// anything malformed, unsupported, or ambiguous — this function is
// also where every "clearly report unsupported query types"
// requirement is enforced (bad join type, non-select source query
// type, more/fewer than two sources).
function validateFederationRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FederationValidationError('Request body must be a JSON object.');
  }

  if (!Array.isArray(body.sources) || body.sources.length === 0) {
    throw new FederationValidationError('"sources" must be a non-empty array.');
  }
  if (body.sources.length !== REQUIRED_SOURCE_COUNT) {
    throw new FederationValidationError(
      `This prototype supports exactly ${REQUIRED_SOURCE_COUNT} sources per federated query (a single join). ` +
        'N-way joins are not implemented yet.',
    );
  }

  const seenAliases = new Set();
  const sources = body.sources.map((rawSource, idx) => {
    if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) {
      throw new FederationValidationError(`sources[${idx}] must be an object.`);
    }

    const dataset = typeof rawSource.dataset === 'string' ? rawSource.dataset.trim() : '';
    if (!dataset) {
      throw new FederationValidationError(`sources[${idx}].dataset is required.`);
    }

    const alias = typeof rawSource.alias === 'string' ? rawSource.alias.trim() : '';
    if (!alias) {
      throw new FederationValidationError(`sources[${idx}].alias is required.`);
    }
    if (seenAliases.has(alias)) {
      throw new FederationValidationError(`Duplicate source alias "${alias}" — aliases must be unique.`);
    }
    seenAliases.add(alias);

    let targetDatabase = null;
    if (rawSource.targetDatabase !== undefined && rawSource.targetDatabase !== null && rawSource.targetDatabase !== '') {
      targetDatabase = String(rawSource.targetDatabase).trim().toLowerCase();
      if (!ALLOWED_TARGET_DATABASES.includes(targetDatabase)) {
        throw new FederationValidationError(
          `sources[${idx}].targetDatabase must be one of: ${ALLOWED_TARGET_DATABASES.join(', ')}.`,
        );
      }
    }

    // Federation only ever runs a filtered fetch per source — search
    // and count don't have a meaningful role on one side of a join in
    // this prototype, so any other queryType is explicitly rejected
    // rather than silently treated as "select".
    if (rawSource.queryType !== undefined && rawSource.queryType !== null && rawSource.queryType !== 'select') {
      throw new FederationValidationError(
        `Unsupported queryType "${rawSource.queryType}" for federated source "${alias}" — only "select" is ` +
          'supported as a federation source in this prototype.',
      );
    }

    const rawConditions = rawSource.conditions;
    if (
      rawConditions !== undefined &&
      rawConditions !== null &&
      (typeof rawConditions !== 'object' || Array.isArray(rawConditions))
    ) {
      throw new FederationValidationError(`sources[${idx}].conditions must be an object.`);
    }

    let conditions;
    try {
      conditions = normalizeFilterConditions(rawConditions || {});
    } catch (error) {
      throw new FederationValidationError(`sources[${idx}] (alias "${alias}"): ${error.message}`);
    }

    let requestedLimit = null;
    if (rawSource.limit !== undefined && rawSource.limit !== null && rawSource.limit !== '') {
      requestedLimit = Number(rawSource.limit);
      if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
        throw new FederationValidationError(`sources[${idx}].limit must be a positive integer.`);
      }
    }
    // Hard cap, regardless of what was requested — this (plus the
    // per-source fetch never running without a LIMIT at all) is what
    // stands in for "prevent uncontrolled full-database scans" here.
    const limit = Math.min(requestedLimit || DEFAULT_SOURCE_ROWS, MAX_SOURCE_ROWS);

    return { dataset, alias, targetDatabase, conditions, limit };
  });

  const rawJoin = body.join;
  if (!rawJoin || typeof rawJoin !== 'object' || Array.isArray(rawJoin)) {
    throw new FederationValidationError(
      '"join" is required and must describe { type, left: { alias, field }, right: { alias, field } }.',
    );
  }

  const joinType = typeof rawJoin.type === 'string' ? rawJoin.type.trim().toLowerCase() : '';
  if (!ALLOWED_JOIN_TYPES.includes(joinType)) {
    throw new FederationValidationError(
      `Unsupported join type "${rawJoin.type}". Supported: ${ALLOWED_JOIN_TYPES.join(', ')} ` +
        '(right/full/cross joins are not implemented in this prototype).',
    );
  }

  const left = validateJoinSide(rawJoin.left, 'join.left', seenAliases);
  const right = validateJoinSide(rawJoin.right, 'join.right', seenAliases);
  if (left.alias === right.alias) {
    throw new FederationValidationError('"join.left.alias" and "join.right.alias" must refer to different sources.');
  }

  let projection = null;
  if (body.projection !== undefined && body.projection !== null) {
    if (!Array.isArray(body.projection) || !body.projection.length) {
      throw new FederationValidationError('"projection" must be a non-empty array of "alias.field" strings.');
    }
    projection = body.projection.map((entry, idx) => {
      if (typeof entry !== 'string' || !entry.includes('.')) {
        throw new FederationValidationError(`projection[${idx}] must be a string in "alias.field" form.`);
      }
      const [alias] = entry.split('.');
      if (!seenAliases.has(alias)) {
        throw new FederationValidationError(`projection[${idx}] references unknown alias "${alias}".`);
      }
      return entry;
    });
  }

  let limit = DEFAULT_RESULT_ROWS;
  if (body.limit !== undefined && body.limit !== null && body.limit !== '') {
    limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new FederationValidationError('"limit" must be a positive integer.');
    }
  }
  limit = Math.min(limit, MAX_RESULT_ROWS);

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (body.timeoutMs !== undefined && body.timeoutMs !== null && body.timeoutMs !== '') {
    timeoutMs = Number(body.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new FederationValidationError('"timeoutMs" must be a positive integer.');
    }
  }
  timeoutMs = Math.min(Math.max(timeoutMs, MIN_TIMEOUT_MS), ABSOLUTE_MAX_TIMEOUT_MS);

  return { sources, join: { type: joinType, left, right }, projection, limit, timeoutMs };
}

// ------------------------------------------------------------
// Dataset resolution + join-field sanity check against metadata
// ------------------------------------------------------------

// Resolves every source's dataset name to a database location the
// same way a single /v1/query does, and — when a schema is on record
// for that dataset (always true for Postgres, sometimes true for
// Mongo/Elasticsearch) — confirms the join field actually exists on
// it. This is the "use metadata to identify related datasets and
// fields" requirement: metadata tells us WHERE each dataset lives
// and WHETHER a claimed field is real, but never guesses which
// fields to join on.
async function resolveSources(sources, join) {
  const resolved = await Promise.all(
    sources.map(async (source) => ({ ...source, location: await resolveDatasetLocation(source.dataset, source.targetDatabase) })),
  );

  const byAlias = new Map(resolved.map((source) => [source.alias, source]));
  const leftSource = byAlias.get(join.left.alias);
  const rightSource = byAlias.get(join.right.alias);

  checkJoinFieldKnown(leftSource, join.left.field, 'join.left.field');
  checkJoinFieldKnown(rightSource, join.right.field, 'join.right.field');

  return { resolved, leftSource, rightSource };
}

function checkJoinFieldKnown(source, field, label) {
  const normalized = normalizeSchema(source.location.schema);
  if (!normalized.length) return; // schema unknown (e.g. legacy/schemaless import) — skip, don't block a legitimate join
  const match = normalized.find((col) => col.field === field);
  if (!match) {
    throw new FederationValidationError(
      `${label} ("${field}") was not found in the recorded schema for source "${source.alias}" (dataset "${source.dataset}").`,
    );
  }
}

// ------------------------------------------------------------
// Stage 1: independent per-source fetch
// ------------------------------------------------------------

const RUNNERS = {
  postgres: runPostgresQuery,
  mongodb: runMongoQuery,
  elasticsearch: runElasticsearchQuery,
};

// Never throws — a failed source comes back as { error } so the
// caller can report a partial/failed federation instead of an
// unhandled rejection tearing down the other, possibly-successful,
// source fetch.
async function fetchSourceRows(source) {
  const runner = RUNNERS[source.location.dbType];
  try {
    const outcome = await runner({
      dbName: source.location.dbName,
      resolvedName: source.location.collectionName,
      schema: source.location.schema,
      queryType: 'select',
      conditions: source.conditions,
      sort: null,
      limit: source.limit,
    });
    return { alias: source.alias, dbType: source.location.dbType, rows: outcome.results, error: null };
  } catch (error) {
    return { alias: source.alias, dbType: source.location.dbType, rows: [], error: redactSensitive(error.message) };
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------
// Stage 2: in-memory join
// ------------------------------------------------------------

// A Mongo document whose identifier column was remapped to `_id` at
// import time no longer carries that column under its original name
// (see database-service.js's writeRowsToTarget) — falling back to
// `_id` here is a best-effort shim for that specific case, documented
// as a known limitation at the top of this file, not a general
// substitute for real foreign-key semantics.
function getJoinValue(row, field) {
  if (row == null) return undefined;
  if (row[field] !== undefined) return row[field];
  if (row._id !== undefined) return row._id;
  return undefined;
}

function buildJoinIndex(rows, field) {
  const index = new Map();
  rows.forEach((row) => {
    const value = getJoinValue(row, field);
    if (value === undefined || value === null) return;
    const key = String(value);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  });
  return index;
}

// A straightforward in-memory hash join over exactly the rows fetched
// in stage 1 — see the file header for what this does and doesn't
// guarantee relative to a real database join.
function performJoin({ type, leftRows, rightRows, leftAlias, leftField, rightAlias, rightField }) {
  const rightIndex = buildJoinIndex(rightRows, rightField);
  const joined = [];

  leftRows.forEach((leftRow) => {
    const value = getJoinValue(leftRow, leftField);
    const matches = value !== undefined && value !== null ? rightIndex.get(String(value)) : undefined;

    if (matches && matches.length) {
      matches.forEach((rightRow) => {
        joined.push({ [leftAlias]: leftRow, [rightAlias]: rightRow });
      });
    } else if (type === 'left') {
      joined.push({ [leftAlias]: leftRow, [rightAlias]: null });
    }
    // inner join: a left row with no match is simply dropped.
  });

  return joined;
}

function applyProjection(rows, projection) {
  if (!projection || !projection.length) return rows;
  return rows.map((row) => {
    const out = {};
    projection.forEach((path) => {
      const [alias, field] = path.split('.');
      const source = row[alias];
      out[path] = source ? source[field] : null;
    });
    return out;
  });
}

// ------------------------------------------------------------
// Main entry point
// ------------------------------------------------------------

// Runs one validated federated query end to end and returns the
// unified response shape. Validation problems (bad request shape,
// unsupported join/query type, unknown join field, an unresolvable
// dataset) are raised as FederationValidationError/QueryValidationError
// so the route can return 400; problems while actually talking to a
// database, or an overall timeout, are caught here and returned as
// part of the normal response with status: "error" — the same
// pattern query-engine.js and database-service.js use.
async function executeFederatedQuery(rawBody) {
  const validated = validateFederationRequest(rawBody);
  const { resolved, leftSource, rightSource } = await resolveSources(validated.sources, validated.join);

  const databasesUsed = [...new Set(resolved.map((source) => source.location.dbType))];
  const queryPlan = {
    sources: resolved.map((source) => ({
      alias: source.alias,
      dataset: source.dataset,
      dbType: source.location.dbType,
      dbName: source.location.dbName,
      resolvedName: source.location.collectionName,
      conditions: source.conditions,
      limit: source.limit,
    })),
    join: validated.join,
    projection: validated.projection,
    limit: validated.limit,
    timeoutMs: validated.timeoutMs,
  };
  const joinField = {
    left: `${validated.join.left.alias}.${validated.join.left.field}`,
    right: `${validated.join.right.alias}.${validated.join.right.field}`,
  };

  let stageResults;
  try {
    stageResults = await withTimeout(
      Promise.all(resolved.map((source) => fetchSourceRows(source))),
      validated.timeoutMs,
      `Federated query timed out after ${validated.timeoutMs}ms.`,
    );
  } catch (timeoutError) {
    return {
      queryPlan,
      databasesUsed,
      rowsRead: {},
      joinField,
      results: [],
      resultCount: 0,
      status: 'error',
      errors: [timeoutError.message],
    };
  }

  const rowsRead = Object.fromEntries(stageResults.map((result) => [result.alias, result.rows.length]));
  const errors = stageResults.filter((result) => result.error).map((result) => `${result.alias} (${result.dbType}): ${result.error}`);

  if (errors.length) {
    // A join needs both sides — if either source failed, there is
    // nothing safe to join, so report the failure(s) rather than
    // guessing at a partial result.
    return { queryPlan, databasesUsed, rowsRead, joinField, results: [], resultCount: 0, status: 'error', errors };
  }

  const leftRows = stageResults.find((result) => result.alias === leftSource.alias).rows;
  const rightRows = stageResults.find((result) => result.alias === rightSource.alias).rows;

  const joined = performJoin({
    type: validated.join.type,
    leftRows,
    rightRows,
    leftAlias: validated.join.left.alias,
    leftField: validated.join.left.field,
    rightAlias: validated.join.right.alias,
    rightField: validated.join.right.field,
  });

  const projected = applyProjection(joined, validated.projection);
  const finalResults = projected.slice(0, validated.limit);

  return {
    queryPlan,
    databasesUsed,
    rowsRead,
    joinField,
    results: finalResults,
    resultCount: finalResults.length,
    status: 'success',
    errors: [],
  };
}

module.exports = {
  FederationValidationError,
  QueryValidationError,
  ALLOWED_JOIN_TYPES,
  REQUIRED_SOURCE_COUNT,
  MAX_SOURCE_ROWS,
  DEFAULT_SOURCE_ROWS,
  MAX_RESULT_ROWS,
  DEFAULT_RESULT_ROWS,
  DEFAULT_TIMEOUT_MS,
  ABSOLUTE_MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  validateFederationRequest,
  resolveSources,
  fetchSourceRows,
  performJoin,
  applyProjection,
  getJoinValue,
  executeFederatedQuery,
};
