/*
 * ============================================================
 * MAESTRO / POLYGLODB unified query engine
 * ============================================================
 *
 * Powers POST /v1/query. Given a dataset name, a query type, and a
 * set of conditions, this module:
 *
 *   1. Resolves WHICH database the dataset lives in, using the
 *      import/partition metadata already recorded by
 *      database-service.js — i.e. the routing decision the routing
 *      engine made back when the data was imported (see
 *      routing-engine.js and requirement "use the profiling and
 *      routing results from the previous phases"). It does not
 *      re-run the routing engine at query time — that engine
 *      classifies raw rows to pick a destination for new data, which
 *      isn't the question a query needs answered.
 *   2. Validates the request shape (query type, operators, sort,
 *      limit, target database override).
 *   3. Builds and runs a SAFE query against exactly one target:
 *        - PostgreSQL: parameterized SQL ($1, $2, ...) against
 *          columns resolved from the table's stored schema.
 *        - MongoDB: a filter object built field-by-field from a
 *          fixed operator whitelist (never the user's raw JSON
 *          passed straight through as a filter).
 *        - Elasticsearch: a structured Query DSL body (term/range/
 *          terms/multi_match), not a hand-built query string.
 *   4. Returns one consistent response shape regardless of which
 *      database served the query.
 *
 * Cross-database joins are explicitly out of scope: if a dataset was
 * partitioned across more than one database and the caller didn't
 * say which one to query, resolveDatasetLocation() raises a clear
 * validation error instead of silently guessing or merging results.
 */

const { Client } = require('pg');
const { MongoClient } = require('mongodb');
const { Client: ESClient } = require('@elastic/elasticsearch');
const { getMetadata, sanitizeIdentifier } = require('./database-service');
const { buildCacheKey, getCachedQueryResult, setCachedQueryResult } = require('./query-cache');
const { redactSensitive } = require('./redact');

class QueryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueryValidationError';
  }
}

const ALLOWED_QUERY_TYPES = ['select', 'search', 'count'];
const ALLOWED_TARGET_DATABASES = ['postgres', 'mongodb', 'elasticsearch'];
const ALLOWED_OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'];
const ALLOWED_SORT_DIRECTIONS = ['asc', 'desc'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
// Statuses metadata can carry that still mean "there is queryable
// data here" — "error" imports left nothing usable, so they're
// excluded when resolving where a dataset lives.
const QUERYABLE_STATUSES = ['imported', 'partial', 'local'];

// ------------------------------------------------------------
// Request validation
// ------------------------------------------------------------

// Turns `{ age: 30 }` or `{ age: { gt: 30, lte: 40 } }` into a flat
// list of { field, operator, value } clauses, rejecting anything
// that isn't one of the whitelisted operators. This whitelist is
// what keeps Mongo's filter-building safe even though Mongo filters
// are plain objects: the operator keys always come from
// ALLOWED_OPERATORS, never straight from the caller's JSON.
function normalizeFilterConditions(rawConditions) {
  return Object.entries(rawConditions)
    .map(([field, rawValue]) => {
      if (!field || typeof field !== 'string') {
        throw new QueryValidationError('Condition field names must be non-empty strings.');
      }

      if (rawValue !== null && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
        const operatorEntries = Object.entries(rawValue);
        if (!operatorEntries.length) {
          throw new QueryValidationError(`Condition for "${field}" has no operator.`);
        }
        return operatorEntries.map(([rawOperator, value]) => {
          const operator = String(rawOperator).trim().toLowerCase();
          if (!ALLOWED_OPERATORS.includes(operator)) {
            throw new QueryValidationError(
              `Invalid operator "${rawOperator}" for field "${field}". Expected one of: ${ALLOWED_OPERATORS.join(', ')}.`,
            );
          }
          if (operator === 'in' && !Array.isArray(value)) {
            throw new QueryValidationError(`Operator "in" for field "${field}" requires an array value.`);
          }
          return { field, operator, value };
        });
      }

      return [{ field, operator: 'eq', value: rawValue }];
    })
    .flat();
}

// Validates and normalizes a raw /v1/query request body. Throws
// QueryValidationError (mapped to HTTP 400 by the route) for
// anything malformed — never partially applies a bad request.
function validateQueryRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new QueryValidationError('Request body must be a JSON object.');
  }

  const dataset = typeof body.dataset === 'string' ? body.dataset.trim() : '';
  if (!dataset) {
    throw new QueryValidationError('A "dataset" name is required.');
  }

  const queryType = typeof body.queryType === 'string' ? body.queryType.trim().toLowerCase() : '';
  if (!ALLOWED_QUERY_TYPES.includes(queryType)) {
    throw new QueryValidationError(`Invalid "queryType". Expected one of: ${ALLOWED_QUERY_TYPES.join(', ')}.`);
  }

  let targetDatabase = null;
  if (body.targetDatabase !== undefined && body.targetDatabase !== null && body.targetDatabase !== '') {
    targetDatabase = String(body.targetDatabase).trim().toLowerCase();
    if (!ALLOWED_TARGET_DATABASES.includes(targetDatabase)) {
      throw new QueryValidationError(
        `Invalid "targetDatabase". Expected one of: ${ALLOWED_TARGET_DATABASES.join(', ')}.`,
      );
    }
  }

  const rawConditions = body.conditions;
  if (
    rawConditions !== undefined &&
    rawConditions !== null &&
    (typeof rawConditions !== 'object' || Array.isArray(rawConditions))
  ) {
    throw new QueryValidationError('"conditions" must be an object.');
  }

  let conditions;
  if (queryType === 'search') {
    const text = rawConditions && typeof rawConditions.text === 'string' ? rawConditions.text.trim() : '';
    if (!text) {
      throw new QueryValidationError('"search" queries require conditions.text (the text to search for).');
    }
    const rawFields = rawConditions && rawConditions.fields !== undefined ? rawConditions.fields : null;
    if (
      rawFields !== null &&
      (!Array.isArray(rawFields) || rawFields.some((f) => typeof f !== 'string' || !f.trim()))
    ) {
      throw new QueryValidationError('"conditions.fields" must be an array of non-empty field names.');
    }
    conditions = { text, fields: rawFields ? rawFields.map((f) => f.trim()) : null };
  } else {
    conditions = normalizeFilterConditions(rawConditions || {});
  }

  let sort = null;
  if (body.sort !== undefined && body.sort !== null) {
    const rawSort = body.sort;
    if (typeof rawSort !== 'object' || Array.isArray(rawSort) || typeof rawSort.field !== 'string' || !rawSort.field.trim()) {
      throw new QueryValidationError('"sort" must be an object like { "field": "columnName", "direction": "asc" }.');
    }
    const direction = rawSort.direction ? String(rawSort.direction).trim().toLowerCase() : 'asc';
    if (!ALLOWED_SORT_DIRECTIONS.includes(direction)) {
      throw new QueryValidationError(`Invalid sort direction. Expected one of: ${ALLOWED_SORT_DIRECTIONS.join(', ')}.`);
    }
    sort = { field: rawSort.field.trim(), direction };
  }

  let limit = DEFAULT_LIMIT;
  if (body.limit !== undefined && body.limit !== null && body.limit !== '') {
    limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new QueryValidationError('"limit" must be a positive integer.');
    }
    if (limit > MAX_LIMIT) {
      throw new QueryValidationError(`"limit" cannot exceed ${MAX_LIMIT}.`);
    }
  }

  return { dataset, queryType, conditions, sort, limit, targetDatabase };
}

// ------------------------------------------------------------
// Dataset -> database resolution (metadata + prior routing result)
// ------------------------------------------------------------

// A postgres schema entry looks like { original, safe, pgType }; a
// mongo/elasticsearch/local schema entry (built from the profiler)
// looks like { column, type }. Normalize both to { field, type } so
// the rest of this module can treat them the same way.
function normalizeSchema(schema) {
  if (!Array.isArray(schema)) return [];
  return schema.map((col) => {
    if (col.original !== undefined) {
      return { field: col.original, type: col.pgType === 'TEXT' ? 'Text' : col.pgType, pgType: col.pgType, safe: col.safe };
    }
    return { field: col.column, type: col.type };
  });
}

function defaultTextFields(schema) {
  return normalizeSchema(schema)
    .filter((col) => col.type === 'Text' || col.type === 'TEXT')
    .map((col) => col.field);
}

// Looks through every import/partition record for one matching this
// dataset name, and returns the single most-recent, still-queryable
// location per database type it was written to. This is exactly the
// destination the routing engine picked at import time — reusing it
// here means /v1/query never re-classifies the data, it just goes
// back to where it was already put.
async function resolveDatasetLocation(dataset, targetDatabase) {
  const metadata = await getMetadata();
  const datasetLower = dataset.toLowerCase();
  const candidates = [];

  (metadata.imports || []).forEach((record) => {
    const name = record.dataset || record.originalName;
    if (name && name.toLowerCase() === datasetLower && QUERYABLE_STATUSES.includes(record.status)) {
      candidates.push({
        dbType: record.dbType,
        dbName: record.dbName,
        collectionName: record.collectionName,
        schema: record.schema || null,
        at: record.importedAt,
      });
    }
  });

  (metadata.partitions || []).forEach((record) => {
    const name = record.dataset;
    if (!name || name.toLowerCase() !== datasetLower) return;
    (record.partitions || []).forEach((partition) => {
      if (QUERYABLE_STATUSES.includes(partition.status)) {
        candidates.push({
          dbType: partition.target,
          dbName: partition.dbName,
          collectionName: partition.collectionName,
          schema: partition.schema || null,
          at: record.createdAt,
        });
      }
    });
  });

  if (!candidates.length) {
    throw new QueryValidationError(
      `Dataset "${dataset}" was not found. Import it first via /database/import or /partition/import.`,
    );
  }

  const latestByType = new Map();
  candidates.forEach((candidate) => {
    const existing = latestByType.get(candidate.dbType);
    if (!existing || new Date(candidate.at || 0) >= new Date(existing.at || 0)) {
      latestByType.set(candidate.dbType, candidate);
    }
  });

  const availableTypes = [...latestByType.keys()].filter((type) => ALLOWED_TARGET_DATABASES.includes(type));

  if (targetDatabase) {
    const location = latestByType.get(targetDatabase);
    if (!location) {
      throw new QueryValidationError(
        `Dataset "${dataset}" has no data in "${targetDatabase}". Available: ${availableTypes.join(', ') || 'none'}.`,
      );
    }
    return location;
  }

  if (!availableTypes.length) {
    throw new QueryValidationError(
      `Dataset "${dataset}" is only stored locally; querying is only supported for postgres, mongodb, and elasticsearch.`,
    );
  }

  if (availableTypes.length > 1) {
    throw new QueryValidationError(
      `Dataset "${dataset}" is split across multiple databases (${availableTypes.join(', ')}). ` +
        'Cross-database joins are not supported yet — pass "targetDatabase" to query one of them directly.',
    );
  }

  return latestByType.get(availableTypes[0]);
}

// ------------------------------------------------------------
// PostgreSQL
// ------------------------------------------------------------

// Maps a caller-supplied field name to the actual (safe, quoted)
// Postgres column, using the table's stored schema. An unknown field
// is a validation error (bad request), not a database error — this
// runs BEFORE any SQL is built, so a typo never reaches the database.
function resolvePostgresColumn(field, schema, resolvedName) {
  if (Array.isArray(schema) && schema.length) {
    const match = schema.find((col) => col.original === field);
    if (!match) {
      throw new QueryValidationError(`Unknown column "${field}" for table "${resolvedName}".`);
    }
    return match.safe;
  }
  // No schema on record (e.g. a legacy import) — sanitize defensively
  // so nothing unsafe is ever interpolated, even though we can't
  // confirm the column exists; Postgres will raise a clear error if
  // it doesn't, which the caller sees in `error`.
  return sanitizeIdentifier(field, { fallbackPrefix: 'col' });
}

const SQL_OPERATORS = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

// Builds a fully parameterized SQL statement — every value (including
// LIMIT) is bound as $1, $2, ...; only table/column names (each
// resolved against the known-safe schema above) are ever interpolated
// into the SQL text itself.
function buildPostgresQuery({ queryType, resolvedName, schema, conditions, sort, limit }) {
  const values = [];
  let whereSql = '';

  if (queryType === 'search') {
    const fields = conditions.fields && conditions.fields.length ? conditions.fields : defaultTextFields(schema);
    if (!fields.length) {
      throw new QueryValidationError(
        'No searchable text columns are known for this table; specify conditions.fields explicitly.',
      );
    }
    const likeClauses = fields.map((field) => {
      const safe = resolvePostgresColumn(field, schema, resolvedName);
      values.push(`%${conditions.text}%`);
      return `"${safe}" ILIKE $${values.length}`;
    });
    whereSql = ` WHERE ${likeClauses.join(' OR ')}`;
  } else if (conditions.length) {
    const clauses = conditions.map(({ field, operator, value }) => {
      const safe = resolvePostgresColumn(field, schema, resolvedName);
      if (operator === 'in') {
        values.push(value);
        return `"${safe}" = ANY($${values.length})`;
      }
      values.push(value);
      return `"${safe}" ${SQL_OPERATORS[operator]} $${values.length}`;
    });
    whereSql = ` WHERE ${clauses.join(' AND ')}`;
  }

  if (queryType === 'count') {
    return { sql: `SELECT COUNT(*) AS count FROM "${resolvedName}"${whereSql}`, values };
  }

  let sql = `SELECT * FROM "${resolvedName}"${whereSql}`;
  if (sort) {
    const safeSortColumn = resolvePostgresColumn(sort.field, schema, resolvedName);
    sql += ` ORDER BY "${safeSortColumn}" ${sort.direction.toUpperCase()}`;
  }
  values.push(limit);
  sql += ` LIMIT $${values.length}`;

  return { sql, values };
}

// Maps a returned row's safe column names back to the caller's
// original field names, so the response mirrors what was imported
// rather than exposing the internal sanitized identifiers.
function mapPostgresRowToOriginal(row, schema) {
  if (!Array.isArray(schema) || !schema.length) return row;
  const mapped = {};
  schema.forEach((col) => {
    mapped[col.original] = row[col.safe];
  });
  Object.keys(row).forEach((key) => {
    if (!schema.some((col) => col.safe === key)) mapped[key] = row[key];
  });
  return mapped;
}

async function runPostgresQuery({ dbName, resolvedName, schema, queryType, conditions, sort, limit }) {
  const { sql, values } = buildPostgresQuery({ queryType, resolvedName, schema, conditions, sort, limit });

  const client = new Client({
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '',
    database: dbName,
  });
  await client.connect();

  try {
    const result = await client.query(sql, values);

    if (queryType === 'count') {
      return { results: [], resultCount: Number(result.rows[0]?.count || 0), plan: { sql, values } };
    }

    const rows = result.rows.map((row) => mapPostgresRowToOriginal(row, schema));
    return { results: rows, resultCount: rows.length, plan: { sql, values } };
  } finally {
    await client.end().catch(() => {});
  }
}

// ------------------------------------------------------------
// MongoDB
// ------------------------------------------------------------

// Builds a Mongo filter object clause-by-clause from the already-
// validated { field, operator, value } list — the operator keys
// written into the filter always come from this fixed map (never
// straight from caller-supplied JSON), so a caller cannot smuggle in
// arbitrary Mongo operators.
const MONGO_OPERATORS = { ne: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte', in: '$in' };

function buildMongoFilter(conditions) {
  const filter = {};
  conditions.forEach(({ field, operator, value }) => {
    if (operator === 'eq') {
      filter[field] = value;
      return;
    }
    const mongoOperator = MONGO_OPERATORS[operator];
    const existing = typeof filter[field] === 'object' && filter[field] !== null && !Array.isArray(filter[field]) ? filter[field] : {};
    filter[field] = { ...existing, [mongoOperator]: value };
  });
  return filter;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMongoSearchFilter({ text, fields }) {
  const pattern = escapeRegex(text);
  return { $or: fields.map((field) => ({ [field]: { $regex: pattern, $options: 'i' } })) };
}

async function runMongoQuery({ dbName, resolvedName, schema, queryType, conditions, sort, limit }) {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017';
  const client = new MongoClient(uri);
  await client.connect();

  try {
    const coll = client.db(dbName).collection(resolvedName);

    let filter;
    if (queryType === 'search') {
      const fields = conditions.fields && conditions.fields.length ? conditions.fields : defaultTextFields(schema);
      if (!fields.length) {
        throw new QueryValidationError(
          'No searchable text fields are known for this dataset; specify conditions.fields explicitly.',
        );
      }
      filter = buildMongoSearchFilter({ text: conditions.text, fields });
    } else {
      filter = buildMongoFilter(conditions);
    }

    if (queryType === 'count') {
      const count = await coll.countDocuments(filter);
      return { results: [], resultCount: count, plan: { filter } };
    }

    let cursor = coll.find(filter);
    if (sort) cursor = cursor.sort({ [sort.field]: sort.direction === 'desc' ? -1 : 1 });
    cursor = cursor.limit(limit);
    const documents = await cursor.toArray();

    return { results: documents, resultCount: documents.length, plan: { filter, sort, limit } };
  } finally {
    await client.close().catch(() => {});
  }
}

// ------------------------------------------------------------
// Elasticsearch
// ------------------------------------------------------------

const ES_RANGE_OPERATORS = { gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte' };

function buildElasticsearchQuery({ queryType, conditions, schema }) {
  if (queryType === 'search') {
    const fields = conditions.fields && conditions.fields.length ? conditions.fields : defaultTextFields(schema);
    return fields.length
      ? { multi_match: { query: conditions.text, fields } }
      : { query_string: { query: conditions.text } };
  }

  if (!conditions.length) {
    return { match_all: {} };
  }

  const must = [];
  const mustNot = [];

  conditions.forEach(({ field, operator, value }) => {
    if (operator === 'eq') {
      must.push({ term: { [field]: value } });
    } else if (operator === 'ne') {
      mustNot.push({ term: { [field]: value } });
    } else if (operator === 'in') {
      must.push({ terms: { [field]: value } });
    } else {
      must.push({ range: { [field]: { [ES_RANGE_OPERATORS[operator]]: value } } });
    }
  });

  return { bool: { must, must_not: mustNot } };
}

async function runElasticsearchQuery({ dbName, resolvedName, schema, queryType, conditions, sort, limit }) {
  const client = new ESClient({ node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200' });
  const query = buildElasticsearchQuery({ queryType, conditions, schema });

  if (queryType === 'count') {
    const response = await client.count({ index: resolvedName, query });
    return { results: [], resultCount: response.count, plan: { query } };
  }

  const searchParams = { index: resolvedName, query, size: limit };
  if (sort) searchParams.sort = [{ [sort.field]: sort.direction }];

  const response = await client.search(searchParams);
  const hits = (response.hits && response.hits.hits) || [];
  const documents = hits.map((hit) => hit._source);

  return { results: documents, resultCount: documents.length, plan: { query, sort, limit } };
}

// ------------------------------------------------------------
// Main entry point
// ------------------------------------------------------------

// Runs one validated request against exactly one resolved database
// and returns the unified response shape. Validation problems (bad
// input, unknown dataset/column, an ambiguous multi-database dataset)
// are raised as QueryValidationError so the route can return 400;
// problems while actually talking to the database (connection
// refused, table doesn't exist, etc.) are caught here and returned as
// part of the normal response with status: "error", the same pattern
// database-service.js uses for imports.
async function executeQuery(rawBody) {
  const validated = validateQueryRequest(rawBody);
  const location = await resolveDatasetLocation(validated.dataset, validated.targetDatabase);

  // Requirement: cache successful, read-only results keyed off
  // dataset + query type + filters + sort + limit. A cache hit skips
  // the database entirely; getCachedQueryResult() itself degrades to
  // a plain miss (returns null) if Redis isn't configured or isn't
  // reachable, so this is always safe to call.
  const cacheKey = buildCacheKey({
    dataset: validated.dataset,
    queryType: validated.queryType,
    conditions: validated.conditions,
    sort: validated.sort,
    limit: validated.limit,
    targetDatabase: validated.targetDatabase,
  });

  const cached = await getCachedQueryResult(cacheKey);
  if (cached) {
    return { ...cached, source: 'cache' };
  }

  const queryPlan = {
    dataset: validated.dataset,
    dbType: location.dbType,
    dbName: location.dbName,
    resolvedName: location.collectionName,
    queryType: validated.queryType,
    conditions: validated.conditions,
    sort: validated.sort,
    limit: validated.limit,
  };

  const runners = {
    postgres: runPostgresQuery,
    mongodb: runMongoQuery,
    elasticsearch: runElasticsearchQuery,
  };

  const runner = runners[location.dbType];
  if (!runner) {
    throw new QueryValidationError(`Querying is not supported for target "${location.dbType}".`);
  }

  try {
    const outcome = await runner({
      dbName: location.dbName,
      resolvedName: location.collectionName,
      schema: location.schema,
      queryType: validated.queryType,
      conditions: validated.conditions,
      sort: validated.sort,
      limit: validated.limit,
    });

    const response = {
      selectedDatabase: location.dbType,
      queryPlan: { ...queryPlan, executedQuery: outcome.plan },
      status: 'success',
      results: outcome.results,
      resultCount: outcome.resultCount,
      error: null,
    };

    // Only a successful result is cached — an "error" status (or a
    // thrown QueryValidationError, below) never gets written, so a
    // transient database failure can't poison the cache for the TTL
    // window.
    await setCachedQueryResult(cacheKey, response);

    return { ...response, source: 'database' };
  } catch (error) {
    // A validation problem discovered while building the query (e.g.
    // an unknown column, caught in resolvePostgresColumn) is still a
    // bad request — propagate it as such instead of masking it as a
    // 200 with status "error".
    if (error instanceof QueryValidationError) {
      throw error;
    }

    return {
      selectedDatabase: location.dbType,
      queryPlan,
      status: 'error',
      results: [],
      resultCount: 0,
      error: { message: redactSensitive(error.message) },
      source: 'database',
    };
  }
}

module.exports = {
  QueryValidationError,
  ALLOWED_QUERY_TYPES,
  ALLOWED_TARGET_DATABASES,
  ALLOWED_OPERATORS,
  ALLOWED_SORT_DIRECTIONS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  validateQueryRequest,
  normalizeFilterConditions,
  normalizeSchema,
  resolveDatasetLocation,
  buildPostgresQuery,
  buildMongoFilter,
  buildMongoSearchFilter,
  buildElasticsearchQuery,
  defaultTextFields,
  executeQuery,

  // exported so federation-engine.js can reuse the same, already-safe
  // single-source execution logic for each side of a join instead of
  // re-implementing per-database query execution.
  runPostgresQuery,
  runMongoQuery,
  runElasticsearchQuery,
};
