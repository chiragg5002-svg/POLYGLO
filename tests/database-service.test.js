const { parseCsv, parseJson, buildMetadataSummary, buildMetadataTable, inferRoutingRecommendation } = require('../database-service');
const { buildRoutingPrompt, parseRoutingRecommendation } = require('../gemini-service');

describe('database service helpers', () => {
  test('parseCsv converts CSV content into row objects', () => {
    const rows = parseCsv('name,age\nAda,36\nGrace,45');

    expect(rows).toEqual([
      { name: 'Ada', age: '36' },
      { name: 'Grace', age: '45' },
    ]);
  });

  test('parseJson returns an array for object and array payloads', () => {
    expect(parseJson('{"name":"Ada"}')).toEqual([{ name: 'Ada' }]);
    expect(parseJson('[{"name":"Ada"},{"name":"Grace"}]')).toEqual([
      { name: 'Ada' },
      { name: 'Grace' },
    ]);
  });

  test('buildMetadataSummary aggregates operation counts', () => {
    const summary = buildMetadataSummary({
      databases: [
        { status: 'created' },
        { status: 'error' },
      ],
      imports: [
        { status: 'imported' },
        { status: 'local' },
        { status: 'error' },
      ],
    });

    expect(summary.totalDatabases).toBe(2);
    expect(summary.totalImports).toBe(3);
    expect(summary.createdDatabases).toBe(1);
    expect(summary.failedOperations).toBe(1);
    expect(summary.lastUpdated).toBeDefined();
  });

  describe('buildMetadataTable', () => {
    test('merges databases and imports into one row shape, newest first', () => {
      const table = buildMetadataTable({
        databases: [
          { dbName: 'shop', dbType: 'postgres', status: 'created', message: 'ok', createdAt: '2026-01-01T00:00:00Z' },
        ],
        imports: [
          {
            dbName: 'shop',
            dbType: 'postgres',
            status: 'imported',
            message: 'Imported 3 rows',
            rowCount: 3,
            importedAt: '2026-01-02T00:00:00Z',
          },
        ],
      });

      expect(table).toHaveLength(2);
      // Newest first: the import (Jan 2) comes before the database
      // creation (Jan 1).
      expect(table[0].type).toBe('import');
      expect(table[0].rowCount).toBe(3);
      expect(table[1].type).toBe('database');
    });

    test('returns an empty array for empty/missing metadata', () => {
      expect(buildMetadataTable({})).toEqual([]);
      expect(buildMetadataTable({ databases: [], imports: [] })).toEqual([]);
    });

    test('handles entries with no timestamp without throwing', () => {
      const table = buildMetadataTable({
        databases: [{ dbName: 'x', dbType: 'postgres', status: 'created', message: 'ok' }],
        imports: [],
      });
      expect(table).toHaveLength(1);
    });
  });

  test('inferRoutingRecommendation detects search-heavy content', () => {
    const recommendation = inferRoutingRecommendation({
      rows: [{ title: 'Sample article', content: 'hello world' }],
      originalName: 'articles.csv',
    });

    expect(recommendation.target).toBe('elasticsearch');
    expect(recommendation.reason).toContain('search');
  });

  test('buildRoutingPrompt creates a compact context for the model', () => {
    const prompt = buildRoutingPrompt({
      rows: [{ title: 'Example', content: 'hello' }],
      originalName: 'articles.csv',
      metadata: { totalImports: 2 },
    });

    expect(prompt).toContain('MAESTRO');
    expect(prompt).toContain('articles.csv');
    expect(prompt).toContain('title');
  });

  test('parseRoutingRecommendation converts a JSON response into a normalized recommendation', () => {
    const parsed = parseRoutingRecommendation('{"target":"postgres","confidence":"high","reason":"structured data","suggestedCollection":"orders"}');

    expect(parsed.target).toBe('postgres');
    expect(parsed.confidence).toBe('high');
    expect(parsed.suggestedCollection).toBe('orders');
  });
});
