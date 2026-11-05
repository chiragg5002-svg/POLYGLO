const { profileDataset } = require('../data-profiler');
const {
  planPartition,
  mergePartitions,
  toPreviewPlan,
  chooseRecordIdentifier,
  classifyColumn,
} = require('../partitioner');

// Builds a plan the same way server.js does: profile first, then plan.
function plan(rows, originalName) {
  const profile = profileDataset(rows, originalName);
  return planPartition({ rows, originalName, profile });
}

function targetsOf(result) {
  return result.partitions.map((p) => p.target).sort();
}

describe('planPartition', () => {
  // ----------------------------------------------------------
  // 1. Flat CSV
  // ----------------------------------------------------------
  test('flat CSV with only relational-looking fields does not need partitioning', () => {
    const rows = [
      { id: '1', name: 'Ada', age: '36' },
      { id: '2', name: 'Grace', age: '45' },
    ];

    const result = plan(rows, 'people.csv');

    expect(result.required).toBe(false);
    expect(result.singleTarget.target).toBe('postgres');
    expect(result.partitions).toHaveLength(1);
    expect(result.partitions[0].target).toBe('postgres');
    expect(result.recordIdentifier.column).toBe('id');
    expect(result.recordIdentifier.synthesized).toBe(false);
  });

  // ----------------------------------------------------------
  // 2. Nested JSON
  // ----------------------------------------------------------
  test('nested JSON with scalar fields alongside nested fields is partitioned into relational + nested', () => {
    const rows = [
      { id: 1, name: 'Ada', profile: { age: 30, tags: ['a', 'b'] } },
      { id: 2, name: 'Grace', profile: { age: 40, tags: ['c'] } },
    ];

    const result = plan(rows, 'users.json');

    expect(result.required).toBe(true);
    expect(targetsOf(result)).toEqual(['mongodb', 'postgres']);

    const mongoPartition = result.partitions.find((p) => p.target === 'mongodb');
    expect(mongoPartition.columns).toContain('profile');
    expect(mongoPartition.columns).toContain('id');

    const pgPartition = result.partitions.find((p) => p.target === 'postgres');
    expect(pgPartition.columns).toContain('name');
  });

  test('purely nested JSON (no scalar fields) does not need partitioning', () => {
    const rows = [
      { profile: { age: 30, tags: ['a'] } },
      { profile: { age: 40, tags: ['b'] } },
    ];

    const result = plan(rows, 'profiles.json');

    expect(result.required).toBe(false);
    expect(result.singleTarget.target).toBe('mongodb');
  });

  // ----------------------------------------------------------
  // 3. Mixed records (heterogeneous rows: some flat, some nested)
  // ----------------------------------------------------------
  test('mixed records — some rows have a nested field populated, others do not', () => {
    const rows = [
      { id: 1, name: 'Ada', extra: { note: 'vip' } },
      { id: 2, name: 'Grace', extra: null },
      { id: 3, name: 'Linus' },
    ];

    const result = plan(rows, 'mixed.json');

    // "extra" is nested often enough to be classified as nested overall;
    // "name" stays relational, so this should split.
    expect(result.required).toBe(true);
    expect(targetsOf(result)).toEqual(['mongodb', 'postgres']);
    // Every partition still carries every row (no data loss).
    result.partitions.forEach((partition) => {
      expect(partition.recordCount).toBe(3);
    });
  });

  // ----------------------------------------------------------
  // 4. Logs
  // ----------------------------------------------------------
  test('log-style data (timestamp/level/message/service) is not split — goes straight to Elasticsearch', () => {
    const rows = [
      { timestamp: '2026-01-01T00:00:00Z', level: 'INFO', message: 'started', service: 'api' },
      { timestamp: '2026-01-01T00:01:00Z', level: 'ERROR', message: 'failed', service: 'api' },
    ];

    const result = plan(rows, 'application_logs.json');

    expect(result.required).toBe(false);
    expect(result.singleTarget.target).toBe('elasticsearch');
  });

  test('logs combined with a nested payload field are split relational/search vs nested', () => {
    const rows = [
      { timestamp: '2026-01-01T00:00:00Z', message: 'started', context: { requestId: 'abc', tags: ['x'] } },
      { timestamp: '2026-01-01T00:01:00Z', message: 'failed', context: { requestId: 'def', tags: ['y'] } },
    ];

    const result = plan(rows, 'logs_with_context.json');

    expect(result.required).toBe(true);
    expect(targetsOf(result)).toContain('mongodb');
    expect(targetsOf(result)).toContain('elasticsearch');
  });

  // ----------------------------------------------------------
  // 5. Missing identifiers
  // ----------------------------------------------------------
  test('dataset with no id-like column gets a synthesized record identifier', () => {
    const rows = [
      { name: 'Ada', age: '36' },
      { name: 'Grace', age: '45' },
    ];

    const result = plan(rows, 'no_id.csv');

    expect(result.recordIdentifier.synthesized).toBe(true);
    expect(result.recordIdentifier.column).toBe('__record_index');
  });

  // ----------------------------------------------------------
  // 6. Duplicate records
  // ----------------------------------------------------------
  test('duplicate identifier values are preserved (not de-duplicated) and produce a warning', () => {
    const rows = [
      { id: '1', name: 'Ada' },
      { id: '1', name: 'Ada Duplicate' },
      { id: '2', name: 'Grace' },
    ];

    const result = plan(rows, 'dupes.csv');

    expect(result.totalRecords).toBe(3);
    expect(result.partitions[0].recordCount).toBe(3);
    expect(result.warnings.some((w) => w.toLowerCase().includes('duplicate'))).toBe(true);

    // Every row is still individually present via __record_index.
    const indices = result.partitions[0].rows.map((r) => r.__record_index);
    expect(indices).toEqual([0, 1, 2]);
  });

  // ----------------------------------------------------------
  // 7. Empty input
  // ----------------------------------------------------------
  test('empty dataset is handled gracefully with no partitioning', () => {
    const result = plan([], 'empty.csv');

    expect(result.required).toBe(false);
    expect(result.partitions).toEqual([]);
    expect(result.totalRecords).toBe(0);
  });

  // ----------------------------------------------------------
  // Long free text -> searchLog classification, plus 3-way split
  // ----------------------------------------------------------
  test('long free-text column is classified as search/log even without a matching field name', () => {
    const longText =
      'This is a long piece of free-form narrative text that goes on for quite a while, well past fifty characters.';

    const rows = [
      { id: 1, price: '9.99', body: longText, meta: { source: 'import' } },
      { id: 2, price: '4.50', body: longText, meta: { source: 'import' } },
    ];

    const result = plan(rows, 'catalog.json');

    expect(result.required).toBe(true);
    expect(targetsOf(result)).toEqual(['elasticsearch', 'mongodb', 'postgres']);
  });

  // ----------------------------------------------------------
  // No data loss: mergePartitions reconstructs the original rows
  // ----------------------------------------------------------
  test('mergePartitions reconstructs the original records from a split plan', () => {
    const rows = [
      { id: 1, name: 'Ada', profile: { age: 30 } },
      { id: 2, name: 'Grace', profile: { age: 40 } },
    ];

    const result = plan(rows, 'users.json');
    const merged = mergePartitions(result);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: 1, name: 'Ada', profile: { age: 30 } });
    expect(merged[1]).toMatchObject({ id: 2, name: 'Grace', profile: { age: 40 } });
  });

  // ----------------------------------------------------------
  // toPreviewPlan strips full row data before it reaches a client
  // ----------------------------------------------------------
  test('toPreviewPlan removes full row payloads but keeps sample records', () => {
    const rows = [
      { id: 1, name: 'Ada', profile: { age: 30 } },
      { id: 2, name: 'Grace', profile: { age: 40 } },
    ];

    const result = plan(rows, 'users.json');
    const preview = toPreviewPlan(result);

    preview.partitions.forEach((partition) => {
      expect(partition.rows).toBeUndefined();
      expect(Array.isArray(partition.sampleRecords)).toBe(true);
    });
  });
});

describe('classifyColumn', () => {
  test('classifies a nested column as "nested"', () => {
    const column = { column: 'profile', type: 'Object', isNested: true };
    expect(classifyColumn(column).category).toBe('nested');
  });

  test('classifies a known log field as "searchLog"', () => {
    const column = { column: 'message', type: 'Text', isNested: false, sampleValues: ['hi'] };
    expect(classifyColumn(column).category).toBe('searchLog');
  });

  test('classifies a transactional field as "relational"', () => {
    const column = { column: 'customer_id', type: 'Text', isNested: false, sampleValues: ['c1'] };
    expect(classifyColumn(column).category).toBe('relational');
  });
});

describe('chooseRecordIdentifier', () => {
  test('picks the highest-cardinality id-style column when several exist', () => {
    const columns = [
      { column: 'order_id', cardinality: 0.5 },
      { column: 'id', cardinality: 1 },
    ];

    const identifier = chooseRecordIdentifier(columns, 10, []);
    expect(identifier.column).toBe('id');
    expect(identifier.synthesized).toBe(false);
  });
});
