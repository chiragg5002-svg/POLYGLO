const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { MongoClient } = require("mongodb");
const { Client: ESClient } = require("@elastic/elasticsearch");
const dotenv = require("dotenv");
const { profileDataset } = require("./data-profiler");
const { IDENTIFIER_NAME_REGEX } = require("./partitioner");
const { invalidateDataset } = require("./query-cache");
const { redactSensitive } = require("./redact");
const { isReservedPhysicalName } = require("./dbaas/reserved");

// Only load the real .env here — do not also load .env.example.
// Loading .env.example would pull placeholder values (fake API keys,
// example connection strings) into process.env whenever a real .env
// value is missing, which makes /connections/status lie about what's
// actually configured. See the matching comment in server.js.
dotenv.config({ path: path.join(__dirname, ".env") });

const DATA_DIR = process.env.MAESTRO_DATA_DIR || path.join(__dirname, "data");
const METADATA_FILE = path.join(DATA_DIR, "metadata.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Thrown for bad input (missing/unsupported dbType, missing dbName,
// empty/unsupported files). server.js maps this to a 400 response so
// the caller gets a clear, actionable message instead of a generic
// 500 — the same pattern data-profiler.js uses for its own
// ProfilingValidationError.
class ImportValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportValidationError";
  }
}

// Names owned by the DBaaS layer (per-project databases, the control
// plane database, per-project Elasticsearch indices) can never be
// targeted by the legacy import/create routes — otherwise those
// unauthenticated routes could be used to write into a tenant's storage.
function assertNotReservedName(name) {
  if (isReservedPhysicalName(name)) {
    throw new ImportValidationError(
      `"${name}" is a reserved name used by MAESTRO projects. Choose a different database name.`,
    );
  }
}

const ALLOWED_DB_TYPES = ["postgres", "mongodb", "elasticsearch", "local"];

function saveMetadata(metadata) {
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), "utf8");
}

function loadMetadata() {
  if (!fs.existsSync(METADATA_FILE)) {
    return { databases: [], imports: [], partitions: [] };
  }
  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, "utf8"));
  metadata.partitions = metadata.partitions || [];
  return metadata;
}

function buildMetadataSummary(metadata = {}) {
  const databases = metadata.databases || [];
  const imports = metadata.imports || [];
  const partitions = metadata.partitions || [];
  const allOperations = [...databases, ...imports];

  return {
    totalDatabases: databases.length,
    totalImports: imports.length,
    createdDatabases: databases.filter((item) => item.status === "created")
      .length,
    failedOperations:
      allOperations.filter((item) => item.status === "error").length > 0
        ? 1
        : 0,
    localPlacements: imports.filter((item) => item.status === "local").length,
    totalPartitionedDatasets: partitions.filter(
      (item) => item.mode === "partitioned",
    ).length,
    lastUpdated: new Date().toISOString(),
  };
}

function inferRoutingRecommendation({ rows = [], originalName = "" } = {}) {
  const sampleText = JSON.stringify(rows.slice(0, 5)).toLowerCase();
  const isSearchHeavy =
    /title|content|description|text|search|article|document/.test(sampleText) ||
    originalName.toLowerCase().includes("search");
  const isTransactional = /order|customer|invoice|payment|user|account/.test(
    sampleText,
  );

  if (isSearchHeavy) {
    return {
      target: "elasticsearch",
      reason:
        "Search-oriented fields suggest Elasticsearch for fast text retrieval.",
      confidence: "high",
    };
  }

  if (isTransactional) {
    return {
      target: "postgres",
      reason:
        "Transactional records fit a relational store with strong consistency.",
      confidence: "medium",
    };
  }

  return {
    target: "mongodb",
    reason: "Flexible document data is a strong fit for MongoDB.",
    confidence: "medium",
  };
}

function buildMetadataTable(metadata = {}) {
  const databases = metadata.databases || [];
  const imports = metadata.imports || [];

  return [
    ...databases.map((item) => ({
      type: "database",
      name: item.dbName,
      target: item.dbType,
      status: item.status,
      message: item.message,
      timestamp: item.createdAt || item.importedAt,
    })),
    ...imports.map((item) => ({
      type: "import",
      name: item.dbName,
      target: item.dbType,
      status: item.status,
      message: item.message,
      timestamp: item.importedAt || item.createdAt,
      rowCount: item.rowCount,
    })),
  ].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}

// ------------------------------------------------------------
// Safe identifiers
// ------------------------------------------------------------
// Turns an arbitrary user-supplied string into something safe to use
// as a PostgreSQL table/column name, a MongoDB collection name, or an
// Elasticsearch index name: lowercase letters/digits/underscores
// only, always starting with a letter or underscore, never empty.
// Used everywhere a name is interpolated into a query/API call
// instead of passed as a bound parameter, since none of those three
// targets let identifiers be parameterized.
function sanitizeIdentifier(
  rawName,
  { fallbackPrefix = "item", maxLength = 63 } = {},
) {
  let name = String(rawName === undefined || rawName === null ? "" : rawName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!name) {
    name = fallbackPrefix;
  }

  if (!/^[a-z_]/.test(name)) {
    name = `${fallbackPrefix}_${name}`;
  }

  return name.slice(0, maxLength) || fallbackPrefix;
}

// Finds the first column whose name looks like a record identifier
// (id, _id, *_id, uuid, guid), the same convention the partitioner
// uses to pick a record identifier — reused here so a direct
// (non-partitioned) import recognizes identifiers the same way.
function detectIdentifierColumn(columnNames = []) {
  return columnNames.find((name) => IDENTIFIER_NAME_REGEX.test(name)) || null;
}

// ------------------------------------------------------------
// PostgreSQL column typing
// ------------------------------------------------------------
// Maps a data-profiler column profile (see data-profiler.js's
// "PROFILE RESULT SHAPE") onto a PostgreSQL column type, so imported
// tables preserve numeric and date types instead of storing
// everything as TEXT. Falls back to TEXT for anything profiling
// didn't classify confidently (Text/Mixed/Unknown), and to JSONB for
// nested data so objects/arrays survive the round trip.
function mapProfileTypeToPostgres(column) {
  if (!column) return "TEXT";

  switch (column.type) {
    case "Boolean":
      return "BOOLEAN";
    case "Numeric": {
      const samples = Array.isArray(column.sampleValues)
        ? column.sampleValues
        : [];
      const allIntegers =
        samples.length > 0 &&
        samples.every((value) => Number.isInteger(Number(value)));
      return allIntegers ? "BIGINT" : "NUMERIC";
    }
    case "Date":
      return "TIMESTAMP";
    case "Object":
    case "Array":
    case "Nested":
      return "JSONB";
    default:
      return "TEXT";
  }
}

// Builds { original, safe, pgType } for every column that appears in
// `rows`, using `profileColumns` (a data-profiler columns array, or
// null) for type information when available. Guarantees every `safe`
// name is unique even if two source columns sanitize to the same
// name (e.g. "User Name" and "user_name").
function buildPostgresSchema(rows, profileColumns) {
  const keys = Object.keys(rows[0] || {});
  const usedNames = new Set();

  return keys.map((key) => {
    const base = sanitizeIdentifier(key, { fallbackPrefix: "col" });
    let safe = base;
    let suffix = 1;
    while (usedNames.has(safe)) {
      safe = `${base}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(safe);

    const profileColumn = Array.isArray(profileColumns)
      ? profileColumns.find((column) => column.column === key)
      : null;

    return {
      original: key,
      safe,
      pgType: mapProfileTypeToPostgres(profileColumn),
    };
  });
}

// Caps a list of per-row/per-document error messages so a bad import
// doesn't return thousands of near-identical error strings.
function summarizeErrors(errors, limit = 5) {
  if (!errors || !errors.length) return [];
  const unique = [...new Set(errors.filter(Boolean))];
  const capped = unique.slice(0, limit);
  if (unique.length > limit) {
    capped.push(`...and ${unique.length - limit} more error(s).`);
  }
  return capped;
}

async function createDatabase({ dbType, dbName, collectionName }) {
  assertNotReservedName(dbName);
  const metadata = loadMetadata();
  const isNameSensitiveTarget =
    dbType === "postgres" || dbType === "elasticsearch";
  const safeDbName = isNameSensitiveTarget
    ? sanitizeIdentifier(dbName, {
        fallbackPrefix: dbType === "elasticsearch" ? "index" : "db",
      })
    : String(dbName || "").trim();

  const record = {
    dbType,
    dbName: safeDbName,
    collectionName: collectionName || null,
    createdAt: new Date().toISOString(),
    status: "pending",
  };

  try {
    if (dbType === "postgres") {
      const client = new Client({
        host: process.env.PG_HOST || "localhost",
        port: Number(process.env.PG_PORT || 5432),
        user: process.env.PG_USER || "postgres",
        password: process.env.PG_PASSWORD || "",
        database: process.env.PG_DATABASE || "postgres",
      });
      await client.connect();
      try {
        await client.query(`CREATE DATABASE "${safeDbName}"`);
        record.status = "created";
        record.message = `PostgreSQL database '${safeDbName}' created successfully.`;
      } catch (error) {
        // 42P04 = duplicate_database — treat re-creating the same
        // database as a success so this call is idempotent.
        if (error.code === "42P04") {
          record.status = "exists";
          record.message = `PostgreSQL database '${safeDbName}' already exists.`;
        } else {
          throw error;
        }
      } finally {
        await client.end().catch(() => {});
      }
    } else if (dbType === "mongodb") {
      const uri = process.env.MONGO_URI || "mongodb://localhost:27017";
      const client = new MongoClient(uri);
      await client.connect();
      try {
        const db = client.db(safeDbName);
        if (collectionName) {
          try {
            await db.createCollection(collectionName);
          } catch (error) {
            // 48 = NamespaceExists — creating the same collection
            // twice should succeed idempotently, not error out.
            if (error.code !== 48 && error.codeName !== "NamespaceExists") {
              throw error;
            }
          }
        }
        record.status = "created";
        record.message = `MongoDB database '${safeDbName}' created successfully.`;
      } finally {
        await client.close().catch(() => {});
      }
    } else if (dbType === "elasticsearch") {
      const client = new ESClient({
        node: process.env.ELASTICSEARCH_URL || "http://localhost:9200",
      });
      try {
        await client.indices.create({ index: safeDbName });
        record.status = "created";
        record.message = `Elasticsearch index '${safeDbName}' created successfully.`;
      } catch (error) {
        const errorType = error?.meta?.body?.error?.type;
        if (errorType === "resource_already_exists_exception") {
          record.status = "exists";
          record.message = `Elasticsearch index '${safeDbName}' already exists.`;
        } else {
          throw error;
        }
      }
    } else {
      record.status = "local";
      record.message =
        "Local metadata placeholder created for unsupported dbType.";
    }
  } catch (error) {
    record.status = "error";
    record.message = redactSensitive(error.message);
  }

  metadata.databases = metadata.databases || [];
  metadata.databases.push(record);
  saveMetadata(metadata);
  return record;
}

function parseCsv(contents) {
  const lines = contents
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(",").map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((value) => value.trim());
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || null;
    });
    return row;
  });
}

function parseJson(contents) {
  const parsed = JSON.parse(contents);
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object") return [parsed];
  throw new Error("JSON file must contain an object or array.");
}

// ------------------------------------------------------------
// Shared per-target write logic
// ------------------------------------------------------------
// Writes `rows` into a single target (postgres/mongodb/elasticsearch/
// local) and returns a result that never throws — callers always get
// a { status, message, insertedCount, failedCount, totalCount, ... }
// shape back, whether every row made it in, none did, or (for
// postgres/mongodb/elasticsearch) some subset failed. Used by both
// the direct single-target import (importFile) and the per-category
// writes produced by the partitioner (importPartitions), so there is
// exactly one place that knows how to talk to each database.
//
// `columns` is an optional data-profiler columns array (used to pick
// PostgreSQL types and preserve numeric/date types); `identifierColumn`
// is an optional column name used as the document/row identifier so
// re-running the same import is idempotent and duplicate identifiers
// are reported instead of silently failing the whole batch.
async function writeRowsToTarget({
  dbType,
  dbName,
  collectionName,
  rows = [],
  columns = null,
  identifierColumn = null,
}) {
  assertNotReservedName(dbName);
  const totalCount = rows.length;

  if (!totalCount) {
    return {
      status: "skipped",
      message: "No rows to import.",
      insertedCount: 0,
      failedCount: 0,
      totalCount: 0,
      errors: [],
    };
  }

  try {
    if (dbType === "postgres") {
      const tableName = sanitizeIdentifier(collectionName || "imported_data", {
        fallbackPrefix: "table",
      });
      const schema = buildPostgresSchema(rows, columns);
      const idColumn = identifierColumn
        ? schema.find((col) => col.original === identifierColumn)
        : null;

      const client = new Client({
        host: process.env.PG_HOST || "localhost",
        port: Number(process.env.PG_PORT || 5432),
        user: process.env.PG_USER || "postgres",
        password: process.env.PG_PASSWORD || "",
        database: dbName,
      });
      await client.connect();

      try {
        const columnDefsSql = schema
          .map((col) => `"${col.safe}" ${col.pgType}`)
          .join(", ");
        // Idempotent: re-importing into the same table reuses it
        // instead of failing because it already exists.
        await client.query(
          `CREATE TABLE IF NOT EXISTS "${tableName}" (${columnDefsSql})`,
        );

        if (idColumn) {
          // Best-effort uniqueness so repeat imports of the same
          // identifier can be skipped via ON CONFLICT below. Ignored
          // if the constraint already exists or existing data already
          // has duplicates — the insert loop still works either way.
          try {
            await client.query(
              `ALTER TABLE "${tableName}" ADD CONSTRAINT "${tableName}_${idColumn.safe}_key" UNIQUE ("${idColumn.safe}")`,
            );
          } catch (constraintError) {
            // Non-fatal — see comment above.
          }
        }

        const columnNamesSql = schema.map((col) => `"${col.safe}"`).join(", ");
        const conflictClause = idColumn
          ? ` ON CONFLICT ("${idColumn.safe}") DO NOTHING`
          : "";

        let insertedCount = 0;
        const errors = [];

        for (const row of rows) {
          const values = schema.map((col) => {
            const value = row ? row[col.original] : undefined;
            if (
              value !== undefined &&
              value !== null &&
              typeof value === "object"
            ) {
              return JSON.stringify(value);
            }
            return value === undefined ? null : value;
          });
          const placeholders = values.map((_, idx) => `$${idx + 1}`).join(", ");

          try {
            const insertResult = await client.query(
              `INSERT INTO "${tableName}" (${columnNamesSql}) VALUES (${placeholders})${conflictClause}`,
              values,
            );
            // With ON CONFLICT DO NOTHING, a skipped duplicate still
            // "succeeds" but affects 0 rows — count it as inserted
            // (idempotent no-op) rather than a failure.
            insertedCount += insertResult.rowCount >= 0 ? 1 : 0;
          } catch (rowError) {
            errors.push(redactSensitive(rowError.message));
          }
        }

        const failedCount = totalCount - insertedCount;
        return {
          status:
            failedCount === 0
              ? "imported"
              : insertedCount === 0
                ? "error"
                : "partial",
          message:
            failedCount === 0
              ? `Imported ${insertedCount} row(s) into PostgreSQL table '${tableName}'.`
              : `Imported ${insertedCount} of ${totalCount} row(s) into PostgreSQL table '${tableName}'; ${failedCount} row(s) failed.`,
          insertedCount,
          failedCount,
          totalCount,
          resolvedName: tableName,
          schema: schema.map(({ original, safe, pgType }) => ({
            original,
            safe,
            pgType,
          })),
          errors: summarizeErrors(errors),
        };
      } finally {
        await client.end().catch(() => {});
      }
    }

    if (dbType === "mongodb") {
      const collName = sanitizeIdentifier(collectionName || "imported_data", {
        fallbackPrefix: "collection",
        maxLength: 120,
      });

      const uri = process.env.MONGO_URI || "mongodb://localhost:27017";
      const client = new MongoClient(uri);
      await client.connect();

      try {
        const db = client.db(dbName);
        const coll = db.collection(collName);

        // Preserve nested objects/arrays as-is — MongoDB documents
        // are schemaless, so no flattening/stringifying is needed.
        // When an identifier column is known, use it as _id so
        // re-importing the same record updates/dedupes instead of
        // creating a second copy (Mongo enforces _id uniqueness).
        const docs = rows.map((row) => {
          if (
            identifierColumn &&
            row &&
            row[identifierColumn] !== undefined &&
            row[identifierColumn] !== null
          ) {
            const { [identifierColumn]: idValue, ...rest } = row;
            return { _id: idValue, ...rest };
          }
          return { ...row };
        });

        let insertedCount = 0;
        let errors = [];

        try {
          // ordered: false — a duplicate identifier or a validation
          // failure on one document does not abort the rest of the
          // batch; every document is attempted.
          const result = await coll.insertMany(docs, { ordered: false });
          insertedCount = result.insertedCount;
        } catch (bulkError) {
          insertedCount =
            bulkError.result?.insertedCount ?? bulkError.insertedCount ?? 0;
          const writeErrors =
            bulkError.writeErrors ||
            bulkError.result?.result?.writeErrors ||
            [];
          if (writeErrors.length) {
            errors = writeErrors.map((writeError) => {
              const err = writeError.err || writeError;
              if (err.code === 11000) {
                return "Duplicate identifier — a document with this identifier was already imported.";
              }
              return redactSensitive(
                err.errmsg || err.message || "Document failed to insert.",
              );
            });
          } else {
            errors = [redactSensitive(bulkError.message)];
          }
        }

        const failedCount = totalCount - insertedCount;
        return {
          status:
            failedCount === 0
              ? "imported"
              : insertedCount === 0
                ? "error"
                : "partial",
          message:
            failedCount === 0
              ? `Imported ${insertedCount} document(s) into MongoDB collection '${collName}'.`
              : `Imported ${insertedCount} of ${totalCount} document(s) into MongoDB collection '${collName}'; ${failedCount} document(s) failed (duplicate identifiers or validation errors).`,
          insertedCount,
          failedCount,
          totalCount,
          resolvedName: collName,
          errors: summarizeErrors(errors),
        };
      } finally {
        await client.close().catch(() => {});
      }
    }

    if (dbType === "elasticsearch") {
      const indexName = sanitizeIdentifier(dbName, {
        fallbackPrefix: "index",
        maxLength: 120,
      });
      const client = new ESClient({
        node: process.env.ELASTICSEARCH_URL || "http://localhost:9200",
      });

      try {
        // Idempotent: only create the index if it doesn't already
        // exist, and tolerate a race where another request created it
        // between the check and the create call.
        const exists = await client.indices.exists({ index: indexName });
        if (!exists) {
          await client.indices.create({ index: indexName });
        }
      } catch (createError) {
        const errorType = createError?.meta?.body?.error?.type;
        if (errorType !== "resource_already_exists_exception") {
          throw createError;
        }
      }

      const bulkOps = [];
      rows.forEach((row) => {
        const meta = { index: { _index: indexName } };
        if (
          identifierColumn &&
          row &&
          row[identifierColumn] !== undefined &&
          row[identifierColumn] !== null
        ) {
          // Using the identifier as the ES document _id makes
          // re-importing the same record idempotent (it overwrites
          // the existing document instead of duplicating it).
          meta.index._id = String(row[identifierColumn]);
        }
        bulkOps.push(meta);
        bulkOps.push(row);
      });

      const bulkResponse = await client.bulk({
        refresh: true,
        operations: bulkOps,
      });

      let insertedCount = 0;
      const errors = [];
      if (bulkResponse.errors) {
        (bulkResponse.items || []).forEach((item) => {
          const action = item.index || item.create || item.update || {};
          if (action.error) {
            errors.push(
              redactSensitive(
                action.error.reason ||
                  action.error.type ||
                  "Unknown Elasticsearch error.",
              ),
            );
          } else {
            insertedCount += 1;
          }
        });
      } else {
        insertedCount = rows.length;
      }

      const failedCount = totalCount - insertedCount;
      return {
        status:
          failedCount === 0
            ? "imported"
            : insertedCount === 0
              ? "error"
              : "partial",
        message:
          failedCount === 0
            ? `Imported ${insertedCount} document(s) into Elasticsearch index '${indexName}'.`
            : `Imported ${insertedCount} of ${totalCount} document(s) into Elasticsearch index '${indexName}'; ${failedCount} document(s) failed.`,
        insertedCount,
        failedCount,
        totalCount,
        resolvedName: indexName,
        errors: summarizeErrors(errors),
      };
    }

    // Local fallback for an unsupported/unset dbType.
    const localCollectionName = sanitizeIdentifier(
      collectionName || "imported_data",
      {
        fallbackPrefix: "dataset",
        maxLength: 120,
      },
    );
    const localDbName = sanitizeIdentifier(dbName || "local", {
      fallbackPrefix: "db",
      maxLength: 60,
    });
    const localPath = path.join(
      DATA_DIR,
      `${localDbName}-${localCollectionName}.json`,
    );
    fs.writeFileSync(localPath, JSON.stringify(rows, null, 2), "utf8");
    return {
      status: "local",
      message: `Saved ${totalCount} row(s) to local file ${localPath}.`,
      insertedCount: totalCount,
      failedCount: 0,
      totalCount,
      resolvedName: localCollectionName,
      errors: [],
    };
  } catch (error) {
    return {
      status: "error",
      message: redactSensitive(error.message),
      insertedCount: 0,
      failedCount: totalCount,
      totalCount,
      errors: [redactSensitive(error.message)],
    };
  }
}

async function importFile({
  dbType,
  dbName,
  collectionName,
  filePath,
  originalName,
}) {
  if (!ALLOWED_DB_TYPES.includes(dbType)) {
    throw new ImportValidationError(
      `Unsupported database type "${dbType}". Expected one of: ${ALLOWED_DB_TYPES.join(", ")}.`,
    );
  }
  if (!dbName || !String(dbName).trim()) {
    throw new ImportValidationError("A database name is required.");
  }
  assertNotReservedName(dbName);

  const metadata = loadMetadata();
  const contents = fs.readFileSync(filePath, "utf8");
  const lowerName = (originalName || "").toLowerCase();
  const fileType = lowerName.endsWith(".json")
    ? "json"
    : lowerName.endsWith(".csv")
      ? "csv"
      : null;

  if (!fileType) {
    throw new ImportValidationError(
      "Unsupported file type. Only CSV and JSON are supported.",
    );
  }

  let rows;
  try {
    rows = fileType === "json" ? parseJson(contents) : parseCsv(contents);
  } catch (parseError) {
    // A malformed file is bad input, not a server fault — map it to
    // the same 400 path as every other validation problem instead of
    // letting a raw JSON.parse SyntaxError fall through as a 500.
    throw new ImportValidationError(
      `Could not parse the uploaded ${fileType.toUpperCase()} file: ${parseError.message}`,
    );
  }

  if (!rows.length) {
    throw new ImportValidationError(
      "No data rows were found in the uploaded file.",
    );
  }

  // Use the profiling results (see data-profiler.js) to pick
  // PostgreSQL column types and detect a record identifier, so a
  // direct import benefits from the same type/identifier awareness
  // as the partitioned import path. Profiling is an enhancement, not
  // a requirement — if it fails for any reason, fall back to
  // untyped columns rather than blocking the import.
  let profileColumns = null;
  let identifierColumn = null;
  try {
    const profile = profileDataset(rows, originalName, { format: fileType });
    profileColumns = profile.columns;
    identifierColumn = detectIdentifierColumn(
      profile.columns.map((column) => column.column),
    );
  } catch (profileError) {
    identifierColumn = detectIdentifierColumn(Object.keys(rows[0] || {}));
  }

  const outcome = await writeRowsToTarget({
    dbType,
    dbName,
    collectionName,
    rows,
    columns: profileColumns,
    identifierColumn,
  });

  const record = {
    dataset: originalName || null,
    dbType,
    dbName,
    collectionName: outcome.resolvedName || collectionName || null,
    fileType,
    rowCount: rows.length,
    schema:
      outcome.schema ||
      (profileColumns
        ? profileColumns.map((c) => ({ column: c.column, type: c.type }))
        : null),
    identifierColumn,
    partitionInfo: null,
    importedAt: new Date().toISOString(),
    status: outcome.status,
    message: outcome.message,
    insertedCount: outcome.insertedCount,
    failedCount: outcome.failedCount,
    errors: outcome.errors || [],
  };

  metadata.imports = metadata.imports || [];
  metadata.imports.push(record);
  saveMetadata(metadata);

  // Requirement: invalidate any cached /v1/query results for this
  // dataset once the underlying data has changed. Only worth doing
  // when something was actually written — an "error" import changed
  // nothing, so there's nothing stale to clear. invalidateDataset()
  // never throws (see query-cache.js), so a Redis outage here can
  // never fail an otherwise-successful import.
  if (["imported", "partial", "local"].includes(record.status)) {
    await invalidateDataset(record.dataset);
  }

  return record;
}

// ------------------------------------------------------------
// Partitioned import
// ------------------------------------------------------------
// Takes a partition plan (see partitioner.js's planPartition, called
// with the FULL plan — not the client-facing preview) and writes each
// partition to its target database, using the same per-target logic
// as a direct import. `targets` maps a target name ("postgres",
// "mongodb", "elasticsearch") to { dbName, collectionName } so the
// caller controls where each partition lands; a target with no entry
// falls back to `defaultDbName` and a collection name derived from
// the original file name plus the partition's category. `profile` is
// the full-dataset data-profiler profile (optional) used to give each
// partition's PostgreSQL columns their proper types.
async function importPartitions({
  plan,
  targets = {},
  defaultDbName,
  originalName,
  profile = null,
}) {
  if (!plan || !plan.partitions || !plan.partitions.length) {
    throw new ImportValidationError(
      "Partition plan has no partitions to import.",
    );
  }

  assertNotReservedName(defaultDbName);
  Object.values(targets || {}).forEach((t) => t && assertNotReservedName(t.dbName));

  const baseName =
    String(originalName || "dataset")
      .replace(/\.(json|csv|tsv)$/i, "")
      .replace(/[^a-zA-Z0-9_]/g, "_") || "dataset";

  const identifierColumn =
    plan.recordIdentifier && !plan.recordIdentifier.synthesized
      ? plan.recordIdentifier.column
      : "__record_index";

  const results = [];

  for (const partition of plan.partitions) {
    const targetConfig = targets[partition.target] || {};
    const dbName = targetConfig.dbName || defaultDbName;
    const collectionName =
      targetConfig.collectionName ||
      (partition.category ? `${baseName}_${partition.category}` : baseName);

    if (!dbName) {
      results.push({
        target: partition.target,
        dbName: null,
        collectionName,
        rowCount: partition.recordCount,
        status: "error",
        message: `No database name provided for target "${partition.target}".`,
        insertedCount: 0,
        failedCount: partition.recordCount,
        errors: [`No database name provided for target "${partition.target}".`],
      });
      continue;
    }

    const partitionProfileColumns =
      profile && Array.isArray(profile.columns)
        ? profile.columns.filter((column) =>
            (partition.columns || []).includes(column.column),
          )
        : null;

    const outcome = await writeRowsToTarget({
      dbType: partition.target,
      dbName,
      collectionName,
      rows: partition.rows || [],
      columns: partitionProfileColumns,
      identifierColumn,
    });

    results.push({
      target: partition.target,
      dbName,
      collectionName: outcome.resolvedName || collectionName,
      columns: partition.columns,
      schema: outcome.schema || null,
      rowCount: partition.recordCount,
      status: outcome.status,
      message: outcome.message,
      insertedCount: outcome.insertedCount,
      failedCount: outcome.failedCount,
      errors: outcome.errors || [],
    });
  }

  const anySucceeded = results.some(
    (r) =>
      r.status === "imported" || r.status === "partial" || r.status === "local",
  );
  const allSucceeded = results.every(
    (r) => r.status === "imported" || r.status === "local",
  );
  const overallStatus = allSucceeded
    ? "imported"
    : anySucceeded
      ? "partial"
      : "error";

  const record = {
    dataset: originalName || null,
    fileType:
      originalName && originalName.toLowerCase().endsWith(".json")
        ? "json"
        : originalName
          ? "csv"
          : null,
    mode: plan.required ? "partitioned" : "single",
    recordIdentifier: plan.recordIdentifier,
    totalRecords: plan.totalRecords,
    partitionInfo: plan.required
      ? {
          strategy: "vertical",
          categories: plan.partitions.map((p) => p.category || null),
        }
      : {
          strategy: "single",
          target: plan.singleTarget ? plan.singleTarget.target : null,
        },
    partitions: results,
    status: overallStatus,
    createdAt: new Date().toISOString(),
  };

  const metadata = loadMetadata();
  metadata.partitions = metadata.partitions || [];
  metadata.partitions.push(record);
  saveMetadata(metadata);

  // Same cache-invalidation rationale as importFile() above — clear
  // any cached /v1/query results for this dataset now that at least
  // one partition's data has changed.
  if (overallStatus !== "error" && record.dataset) {
    await invalidateDataset(record.dataset);
  }

  return record;
}

async function getMetadata() {
  return loadMetadata();
}

module.exports = {
  createDatabase,
  importFile,
  importPartitions,
  writeRowsToTarget,
  getMetadata,
  parseCsv,
  parseJson,
  buildMetadataSummary,
  inferRoutingRecommendation,
  buildMetadataTable,
  ImportValidationError,

  // exported for unit testing
  sanitizeIdentifier,
  mapProfileTypeToPostgres,
  buildPostgresSchema,
  detectIdentifierColumn,
  summarizeErrors,
};
