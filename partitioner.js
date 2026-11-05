/*
 * ============================================================
 * MAESTRO / POLYGLODB — automatic data partitioner
 * ============================================================
 *
 * Decides whether an uploaded dataset needs to be SPLIT across more
 * than one of the three supported stores, and if so, how.
 *
 * This module is deliberately independent of the earlier
 * profiling/routing decision (data-profiler.js, routing-engine.js):
 * it is handed a dataset's rows plus its column profile (produced by
 * data-profiler.profileDataset) and works out a partition PLAN. It
 * never talks to a real database — server.js is responsible for
 * turning a plan into actual writes.
 *
 * ------------------------------------------------------------
 * Strategy: VERTICAL (column-based) partitioning
 * ------------------------------------------------------------
 * Every column is classified into exactly one of three categories,
 * using explainable, deterministic rules (never randomly):
 *
 *   - "nested"    -> MongoDB   (Object/Array/Nested-typed columns)
 *   - "searchLog" -> Elasticsearch (log/full-text-oriented columns,
 *                    by name or by being long free text)
 *   - "relational"-> PostgreSQL (everything else: scalars, dates,
 *                    booleans, short text, transactional fields)
 *
 * If every data column lands in the same category, partitioning is
 * NOT required — the whole dataset is simply routed to that one
 * store (requirement: "if partitioning is not required, store the
 * complete dataset in the best database").
 *
 * If two or more categories are present, the dataset is split
 * vertically: each partition gets only the columns in its category,
 * plus a record identifier so every partition can be traced back to
 * the original row and joined with the others. No rows are ever
 * dropped and no column is ever placed in more than one partition,
 * so the union of all partitions reconstructs the source dataset
 * exactly (see mergePartitions()).
 */

const {
  LOG_FIELDS,
  FULLTEXT_FIELDS,
  TRANSACTIONAL_REGEX,
  SEARCH_HINT_REGEX,
} = require("./routing-engine");

const CATEGORY_TARGET = {
  relational: "postgres",
  nested: "mongodb",
  searchLog: "elasticsearch",
};

const TARGET_LABEL = {
  postgres: "PostgreSQL",
  mongodb: "MongoDB",
  elasticsearch: "Elasticsearch",
};

// A Text column whose sample values average at least this many
// characters is treated as free text worth indexing for search,
// even if its name doesn't match a known search/log field.
const LONG_TEXT_AVERAGE_LENGTH = 50;

// Columns that identify a record. Matched case-insensitively.
const IDENTIFIER_NAME_REGEX = /(^id$)|(^_id$)|(_id$)|(^uuid$)|(^guid$)/i;

// Cap on how many projected rows go into a preview response — the
// plan still covers every row (recordCount is always the full
// count), this only bounds what's echoed back for inspection.
const DEFAULT_SAMPLE_LIMIT = 5;

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

function average(numbers) {
  if (!numbers.length) return 0;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function averageSampleLength(column) {
  const samples = Array.isArray(column.sampleValues) ? column.sampleValues : [];
  if (!samples.length) return 0;
  return average(samples.map((value) => String(value).length));
}

function estimateBytes(rows) {
  try {
    return Buffer.byteLength(JSON.stringify(rows), "utf8");
  } catch (error) {
    return 0;
  }
}

// ------------------------------------------------------------
// Step 1: pick a record identifier
// ------------------------------------------------------------
// Looks for an existing id-like column with reasonably high
// cardinality. If none is found, a synthetic one (row position) is
// used instead so every partition can still be traced and rejoined.
function chooseRecordIdentifier(columns, rowCount, rules) {
  const candidates = columns.filter((column) => IDENTIFIER_NAME_REGEX.test(column.column));

  if (candidates.length > 0) {
    // Prefer the candidate closest to being a true unique key.
    const best = candidates.reduce((a, b) => (b.cardinality > a.cardinality ? b : a));

    const duplicateCount = rowCount - Math.round(best.cardinality * rowCount);

    rules.push({
      rule: "identifier-detection",
      detail: `Column "${best.column}" matches an id-style name and was chosen as the record identifier (cardinality ${best.cardinality}).`,
    });

    return {
      column: best.column,
      synthesized: false,
      duplicateCount: Math.max(0, duplicateCount),
      reason: `"${best.column}" looks like an identifier column, so it is carried into every partition to allow records to be rejoined.`,
    };
  }

  rules.push({
    rule: "identifier-detection",
    detail:
      "No id/_id/uuid/guid-style column was found, so a synthetic identifier (row position) was generated instead.",
  });

  return {
    column: "__record_index",
    synthesized: true,
    duplicateCount: 0,
    reason:
      "No identifier column was present in the source data; a synthetic __record_index (0-based row position) is added to every partition instead so records can still be traced and rejoined.",
  };
}

// ------------------------------------------------------------
// Step 2: classify every non-identifier column
// ------------------------------------------------------------
function classifyColumn(column) {
  const name = column.column.toLowerCase();

  if (column.isNested) {
    return {
      category: "nested",
      reason: `Type "${column.type}" (nested object/array data) fits a flexible document store.`,
    };
  }

  if (LOG_FIELDS.includes(name)) {
    return {
      category: "searchLog",
      reason: `"${column.column}" is a log-oriented field name, best served by full-text search/indexing.`,
    };
  }

  if (FULLTEXT_FIELDS.includes(name) || SEARCH_HINT_REGEX.test(name)) {
    return {
      category: "searchLog",
      reason: `"${column.column}" is a search/content-oriented field name, best served by full-text indexing.`,
    };
  }

  if (column.type === "Text" && averageSampleLength(column) >= LONG_TEXT_AVERAGE_LENGTH) {
    return {
      category: "searchLog",
      reason: `"${column.column}" holds long free-form text (avg. ${Math.round(
        averageSampleLength(column),
      )} chars), which benefits from full-text indexing rather than exact-match storage.`,
    };
  }

  if (TRANSACTIONAL_REGEX.test(name)) {
    return {
      category: "relational",
      reason: `"${column.column}" is a transactional-style field, well suited to a relational schema with strong consistency.`,
    };
  }

  return {
    category: "relational",
    reason: `"${column.column}" is a structured scalar field (type "${column.type}"), which fits a relational schema.`,
  };
}

// ------------------------------------------------------------
// Step 3: project rows for one partition
// ------------------------------------------------------------
function projectRows(rows, identifier, columnNames, sampleLimit) {
  const full = rows.map((row, index) => {
    const projected = {};

    if (identifier.synthesized) {
      projected.__record_index = index;
    } else {
      projected[identifier.column] = row ? row[identifier.column] : undefined;
      projected.__record_index = index;
    }

    columnNames.forEach((name) => {
      projected[name] = row ? row[name] : undefined;
    });

    return projected;
  });

  return {
    rows: full,
    sample: full.slice(0, sampleLimit),
  };
}

// ------------------------------------------------------------
// Main entry point
// ------------------------------------------------------------
// `rows` is the parsed dataset (array of objects), `profile` is the
// result of data-profiler.profileDataset(rows, originalName) for the
// same dataset, and `originalName` is the uploaded file name.
function planPartition({ rows = [], originalName = "", profile, sampleLimit = DEFAULT_SAMPLE_LIMIT } = {}) {
  const rules = [];
  const warnings = [];

  if (!profile || profile.isEmpty || !rows.length) {
    return {
      required: false,
      reason: "Dataset is empty — there is nothing to partition or store.",
      rulesApplied: [{ rule: "empty-input", detail: "No rows were found in the uploaded dataset." }],
      recordIdentifier: null,
      categorization: [],
      singleTarget: null,
      partitions: [],
      sourceToTargetMapping: {},
      relationshipInformation: "",
      warnings: [],
      totalRecords: 0,
    };
  }

  const columns = profile.columns || [];
  const totalRecords = rows.length;

  const recordIdentifier = chooseRecordIdentifier(columns, totalRecords, rules);

  if (recordIdentifier.duplicateCount > 0) {
    warnings.push(
      `${recordIdentifier.duplicateCount} row(s) share a duplicate "${recordIdentifier.column}" value. ` +
        "Every row is still preserved (nothing is de-duplicated); each partitioned row also carries " +
        "a __record_index so duplicates remain individually traceable.",
    );
  }

  // Columns that are themselves the identifier are not re-classified
  // into a category — they ride along in every partition instead.
  const dataColumns = columns.filter((column) => column.column !== recordIdentifier.column);

  const categorization = dataColumns.map((column) => {
    const { category, reason } = classifyColumn(column);
    rules.push({ rule: `classify:${column.column}`, detail: reason });
    return { column: column.column, type: column.type, category, target: CATEGORY_TARGET[category], reason };
  });

  const categoriesPresent = [...new Set(categorization.map((entry) => entry.category))];

  const sourceToTargetMapping = {};
  categorization.forEach((entry) => {
    sourceToTargetMapping[entry.column] = entry.target;
  });

  // The identifier (real or synthetic) is present in every partition,
  // so it maps to every target that ends up being used.
  const targetsInUse =
    categoriesPresent.length > 0
      ? [...new Set(categoriesPresent.map((category) => CATEGORY_TARGET[category]))]
      : [];

  // ----------------------------------------------------------
  // No partitioning needed: everything lands in one category.
  // ----------------------------------------------------------
  if (categoriesPresent.length <= 1) {
    const category = categoriesPresent[0] || "relational";
    const target = CATEGORY_TARGET[category];

    sourceToTargetMapping[recordIdentifier.column] = target;

    rules.push({
      rule: "partition-decision",
      detail:
        categorization.length === 0
          ? "No classifiable data columns were found besides the identifier; defaulting to a relational store."
          : `All ${categorization.length} data column(s) belong to the same category ("${category}"), so the dataset does not need to be split.`,
    });

    const { rows: fullRows, sample } = projectRows(rows, recordIdentifier, dataColumns.map((c) => c.column), sampleLimit);

    return {
      required: false,
      reason: `Partitioning is not required — the dataset is best stored as a single ${TARGET_LABEL[target]} collection.`,
      rulesApplied: rules,
      recordIdentifier,
      categorization,
      singleTarget: {
        target,
        reason: `All fields fit the "${category}" category, so the complete dataset is stored in ${TARGET_LABEL[target]} without splitting.`,
      },
      partitions: [
        {
          target,
          strategy: "single",
          columns: [recordIdentifier.column, ...dataColumns.map((c) => c.column)],
          recordCount: totalRecords,
          approxSizeBytes: estimateBytes(fullRows),
          rows: fullRows,
          sampleRecords: sample,
          reason: `Complete dataset stored in ${TARGET_LABEL[target]}.`,
        },
      ],
      sourceToTargetMapping,
      relationshipInformation:
        "Only one partition was created, so no cross-database relationship tracking is needed.",
      warnings,
      totalRecords,
    };
  }

  // ----------------------------------------------------------
  // Partitioning needed: one partition per category in use.
  // ----------------------------------------------------------
  rules.push({
    rule: "partition-decision",
    detail: `${categoriesPresent.length} distinct data categories were found (${categoriesPresent.join(
      ", ",
    )}), so the dataset is split vertically — one partition per category, each keeping the record identifier so rows can be rejoined.`,
  });

  const partitions = ["relational", "nested", "searchLog"]
    .filter((category) => categoriesPresent.includes(category))
    .map((category) => {
      const target = CATEGORY_TARGET[category];
      const columnNames = categorization.filter((entry) => entry.category === category).map((entry) => entry.column);

      const { rows: fullRows, sample } = projectRows(rows, recordIdentifier, columnNames, sampleLimit);

      return {
        target,
        strategy: "vertical",
        category,
        columns: [recordIdentifier.column, ...columnNames],
        recordCount: totalRecords,
        approxSizeBytes: estimateBytes(fullRows),
        rows: fullRows,
        sampleRecords: sample,
        reason: `${columnNames.length} column(s) classified as "${category}" (${columnNames.join(
          ", ",
        )}) are stored in ${TARGET_LABEL[target]}.`,
      };
    });

  return {
    required: true,
    reason: `The dataset mixes ${categoriesPresent.length} kinds of data, so it is split across ${targetsInUse
      .map((target) => TARGET_LABEL[target])
      .join(", ")}.`,
    rulesApplied: rules,
    recordIdentifier,
    categorization,
    singleTarget: null,
    partitions,
    sourceToTargetMapping,
    relationshipInformation: `Every partition carries the "${recordIdentifier.column}" field (plus a __record_index) so the original record can be reconstructed by joining partitions on that value — see mergePartitions().`,
    warnings,
    totalRecords,
  };
}

// ------------------------------------------------------------
// Reconstructs the original rows from a partition plan's projected
// partitions. Used to demonstrate/verify that no data is lost when a
// dataset is split, and to preview "the full record" after a split.
// ------------------------------------------------------------
function mergePartitions(plan) {
  if (!plan || !plan.partitions || !plan.partitions.length) {
    return [];
  }

  const byIndex = new Map();

  plan.partitions.forEach((partition) => {
    const records = partition.rows || partition.sampleRecords || [];
    records.forEach((record) => {
      const idx = record.__record_index;
      const existing = byIndex.get(idx) || {};
      byIndex.set(idx, { ...existing, ...record });
    });
  });

  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, record]) => record);
}

// ------------------------------------------------------------
// Strips the (potentially large) full `rows` array out of each
// partition before a plan is sent to a client — preview responses
// should only ever carry the bounded sampleRecords, never the whole
// dataset. Server-side code that actually imports the data should
// use the plan returned by planPartition() directly, before calling
// this.
// ------------------------------------------------------------
function toPreviewPlan(plan) {
  if (!plan) return plan;

  return {
    ...plan,
    partitions: plan.partitions.map(({ rows, ...rest }) => rest), // eslint-disable-line no-unused-vars
  };
}

module.exports = {
  CATEGORY_TARGET,
  TARGET_LABEL,
  planPartition,
  mergePartitions,
  toPreviewPlan,

  // exported for unit testing
  chooseRecordIdentifier,
  classifyColumn,
  IDENTIFIER_NAME_REGEX,
  LONG_TEXT_AVERAGE_LENGTH,
};
