const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  profileFile,
  profileDataset,
  profileColumn,
  parseCsv,
  parseJson,
  detectType,
  isMissing,
  isBoolean,
  isNumber,
  isDate,
  isNestedValue,
  looksLikeDate,
  stableStringify,
  computeSampleValues,
  calculateQuality,
  standardDeviation,
  detectNumericPattern,
  profileNumeric,
  profileDate,
  profileBoolean,
  detectDatasetPatterns,
  detectFormatFromName,
  ProfilingValidationError,
} = require('../data-profiler');

function writeTempFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-profiler-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

// ------------------------------------------------------------
// Value-level helpers
// ------------------------------------------------------------

describe('isMissing', () => {
  test('treats null, undefined and blank strings as missing', () => {
    expect(isMissing(null)).toBe(true);
    expect(isMissing(undefined)).toBe(true);
    expect(isMissing('')).toBe(true);
    expect(isMissing('   ')).toBe(true);
  });

  test('does not treat 0, false, or empty arrays/objects as missing', () => {
    expect(isMissing(0)).toBe(false);
    expect(isMissing(false)).toBe(false);
    expect(isMissing([])).toBe(false);
    expect(isMissing({})).toBe(false);
  });
});

describe('isBoolean / isNumber / isDate', () => {
  test('isBoolean recognizes real booleans and true/false strings only', () => {
    expect(isBoolean(true)).toBe(true);
    expect(isBoolean('false')).toBe(true);
    expect(isBoolean('TRUE')).toBe(true);
    expect(isBoolean('yes')).toBe(false);
    expect(isBoolean({})).toBe(false);
  });

  test('isNumber recognizes numeric strings and rejects booleans/nested values', () => {
    expect(isNumber('42')).toBe(true);
    expect(isNumber('3.14')).toBe(true);
    expect(isNumber('true')).toBe(false);
    expect(isNumber([5])).toBe(false); // guards against Number([5]) === 5
    expect(isNumber([])).toBe(false); // guards against Number([]) === 0
    expect(isNumber('')).toBe(false);
  });

  test('isDate recognizes date strings but not plain numbers', () => {
    expect(isDate('2024-01-15')).toBe(true);
    expect(isDate('2024-01-15T10:00:00Z')).toBe(true);
    expect(isDate('01/15/2024')).toBe(true);
    expect(isDate('January 5, 2024')).toBe(true);
    expect(isDate('12345')).toBe(false);
    expect(isDate('not a date')).toBe(false);
    expect(isDate({})).toBe(false);
  });

  test('does not mistake ID-like strings for dates despite JS Date() leniency', () => {
    // new Date("C-1001") silently parses as the year 1001 in V8 — make
    // sure the profiler never trusts the built-in parser blindly.
    expect(looksLikeDate('C-1001')).toBe(false);
    expect(isDate('C-1001')).toBe(false);
    expect(isDate('SKU-2024')).toBe(false);
    expect(isDate('ORDER-99')).toBe(false);
  });
});

describe('isNestedValue / stableStringify', () => {
  test('isNestedValue is true only for non-null objects/arrays', () => {
    expect(isNestedValue({})).toBe(true);
    expect(isNestedValue([])).toBe(true);
    expect(isNestedValue(null)).toBe(false);
    expect(isNestedValue('text')).toBe(false);
  });

  test('stableStringify distinguishes different objects instead of collapsing to [object Object]', () => {
    const a = stableStringify({ id: 1 });
    const b = stableStringify({ id: 2 });
    expect(a).not.toBe(b);
    expect(stableStringify(null)).toBe('');
    expect(stableStringify(42)).toBe('42');
  });
});

describe('computeSampleValues', () => {
  test('returns up to the limit of distinct, non-missing values in order', () => {
    const samples = computeSampleValues([null, 'a', 'a', 'b', '', 'c', 'd', 'e', 'f'], 3);
    expect(samples).toEqual(['a', 'b', 'c']);
  });

  test('dedupes nested objects by content, not reference', () => {
    const samples = computeSampleValues([{ id: 1 }, { id: 1 }, { id: 2 }]);
    expect(samples).toHaveLength(2);
  });
});

// ------------------------------------------------------------
// detectType
// ------------------------------------------------------------

describe('detectType', () => {
  test('detects Boolean, Numeric, Date, Text columns', () => {
    expect(detectType(['true', 'false', 'true'])).toBe('Boolean');
    expect(detectType(['1', '2', '3.5'])).toBe('Numeric');
    expect(detectType(['2024-01-01', '2024-02-01'])).toBe('Date');
    expect(detectType(['apple', 'banana', 'cherry'])).toBe('Text');
  });

  test('returns Unknown when every value is missing', () => {
    expect(detectType([null, undefined, ''])).toBe('Unknown');
  });

  test('detects Array and Object columns from JSON values', () => {
    expect(detectType([[1, 2], [3, 4], [5]])).toBe('Array');
    expect(detectType([{ a: 1 }, { b: 2 }])).toBe('Object');
  });

  test('detects Nested when a column mixes arrays and objects', () => {
    expect(detectType([{ a: 1 }, [1, 2], { b: 2 }, [3]])).toBe('Nested');
  });

  test('detects Mixed when no single scalar type dominates', () => {
    expect(detectType(['42', 'true', '2024-01-01', '17', 'false'])).toBe('Mixed');
  });

  test('a single-element numeric array is not misread as a number', () => {
    // Number([5]) === 5 in JS; make sure the profiler does not fall for this.
    expect(detectType([[5], [6], [7]])).toBe('Array');
  });
});

// ------------------------------------------------------------
// Quality / stats helpers
// ------------------------------------------------------------

describe('calculateQuality', () => {
  test('maps missing percentage to a quality tier', () => {
    expect(calculateQuality(0)).toBe('EXCELLENT');
    expect(calculateQuality(3)).toBe('GOOD');
    expect(calculateQuality(15)).toBe('FAIR');
    expect(calculateQuality(50)).toBe('POOR');
  });
});

describe('standardDeviation', () => {
  test('returns 0 for fewer than 2 numbers', () => {
    expect(standardDeviation([5], 5)).toBe(0);
  });

  test('computes population standard deviation', () => {
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9], 5)).toBeCloseTo(2, 5);
  });
});

describe('detectNumericPattern', () => {
  test('reports insufficient data under 3 points', () => {
    expect(detectNumericPattern([1, 2])).toBe('INSUFFICIENT_DATA');
  });

  test('detects roughly-symmetric, right-skewed and left-skewed shapes', () => {
    expect(detectNumericPattern([1, 2, 3, 4, 5])).toBe('ROUGHLY-SYMMETRIC');
    expect(detectNumericPattern([1, 1, 1, 1, 100])).toBe('RIGHT-SKEWED');
    expect(detectNumericPattern([100, 100, 100, 100, 1])).toBe('LEFT-SKEWED');
  });
});

describe('profileNumeric / profileDate / profileBoolean', () => {
  test('profileNumeric computes min/max/average/median/stdDev', () => {
    const stats = profileNumeric(['1', '2', '3', '4', '5']);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(5);
    expect(stats.average).toBe(3);
    expect(stats.median).toBe(3);
  });

  test('profileDate computes earliest/latest/span', () => {
    const stats = profileDate(['2024-01-01', '2024-01-11']);
    expect(stats.earliestDate).toBe('2024-01-01');
    expect(stats.latestDate).toBe('2024-01-11');
    expect(stats.timeSpanDays).toBe(10);
  });

  test('profileBoolean counts true/false', () => {
    const stats = profileBoolean(['true', 'false', 'true', true]);
    expect(stats.trueCount).toBe(3);
    expect(stats.falseCount).toBe(1);
    expect(stats.truePercentage).toBe(75);
  });

  test('all three return {} when there is nothing valid to profile', () => {
    expect(profileNumeric(['a', 'b'])).toEqual({});
    expect(profileDate(['a', 'b'])).toEqual({});
    expect(profileBoolean(['a', 'b'])).toEqual({});
  });
});

// ------------------------------------------------------------
// profileColumn
// ------------------------------------------------------------

describe('profileColumn', () => {
  test('profiles a numeric column with missing values', () => {
    const rows = [{ age: '10' }, { age: '20' }, { age: null }, { age: '40' }];
    const result = profileColumn(rows, 'age');

    expect(result.type).toBe('Numeric');
    expect(result.missingCount).toBe(1);
    expect(result.missingPercentage).toBe(25);
    expect(result.quality).toBe('POOR');
    expect(result.min).toBe(10);
    expect(result.max).toBe(40);
    expect(result.isNested).toBe(false);
    expect(result.nestedType).toBeNull();
    expect(result.sampleValues).toEqual(['10', '20', '40']);
  });

  test('profiles a nested JSON column and reports isNested/nestedType', () => {
    const rows = [
      { tags: ['a', 'b'] },
      { tags: ['c'] },
      { tags: [] },
    ];
    const result = profileColumn(rows, 'tags');

    expect(result.type).toBe('Array');
    expect(result.isNested).toBe(true);
    expect(result.nestedType).toBe('array');
    expect(result.missingCount).toBe(0); // [] is a present value, not missing
  });

  test('computes cardinality and unique counts correctly for objects', () => {
    const rows = [
      { address: { city: 'A' } },
      { address: { city: 'A' } },
      { address: { city: 'B' } },
    ];
    const result = profileColumn(rows, 'address');

    expect(result.type).toBe('Object');
    expect(result.uniqueValues).toBe(2); // NOT 1 (String({}) collapse bug)
    expect(result.cardinality).toBeCloseTo(2 / 3, 4);
  });
});

// ------------------------------------------------------------
// profileDataset
// ------------------------------------------------------------

describe('profileDataset', () => {
  test('rejects non-array input', () => {
    expect(() => profileDataset({}, 'bad.json')).toThrow(ProfilingValidationError);
  });

  test('returns a valid empty-dataset shape for zero rows', () => {
    const result = profileDataset([], 'empty.csv', { format: 'csv' });
    expect(result.isEmpty).toBe(true);
    expect(result.rowCount).toBe(0);
    expect(result.columnCount).toBe(0);
    expect(result.columns).toEqual([]);
    expect(result.datasetPatterns.primary).toBe('unknown');
  });

  test('profiles a flat tabular dataset and unions columns across ragged rows', () => {
    const rows = [
      { name: 'Alice', age: '30' },
      { name: 'Bob' }, // missing "age"
    ];
    const result = profileDataset(rows, 'people.csv', { format: 'csv' });

    expect(result.columnCount).toBe(2);
    const ageColumn = result.columns.find((c) => c.column === 'age');
    expect(ageColumn.missingCount).toBe(1);
    expect(result.datasetPatterns.tabular.matched).toBe(true);
    expect(result.hasNestedData).toBe(false);
  });

  test('wraps non-object rows (e.g. a bare JSON array of primitives) instead of crashing', () => {
    const result = profileDataset([1, 2, 3], 'numbers.json', { format: 'json' });
    expect(result.columnCount).toBe(1);
    expect(result.columns[0].column).toBe('value');
    expect(result.warnings.some((w) => w.includes('wrapped'))).toBe(true);
  });

  test('flags nested document data for JSON with object/array fields', () => {
    const rows = [
      { id: 1, profile: { age: 30, tags: ['a', 'b'] } },
      { id: 2, profile: { age: 40, tags: ['c'] } },
    ];
    const result = profileDataset(rows, 'users.json', { format: 'json' });

    expect(result.hasNestedData).toBe(true);
    expect(result.datasetPatterns.nestedDocument.matched).toBe(true);
    expect(result.datasetPatterns.primary).toBe('nestedDocument');
  });
});

// ------------------------------------------------------------
// Dataset pattern detection
// ------------------------------------------------------------

describe('detectDatasetPatterns', () => {
  function columnsFor(rows, format) {
    const columnSet = new Set();
    rows.forEach((row) => Object.keys(row).forEach((key) => columnSet.add(key)));
    return [...columnSet].map((column) => profileColumn(rows, column));
  }

  test('detects search/log data from canonical log field names', () => {
    const rows = [
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', message: 'started', service: 'api' },
      { timestamp: '2024-01-01T00:01:00Z', level: 'error', message: 'failed', service: 'api' },
    ];
    const columns = columnsFor(rows, 'json');
    const result = detectDatasetPatterns({ rows, columns, format: 'json', originalName: 'logs.json' });

    expect(result.searchLog.matched).toBe(true);
    expect(result.primary).toBe('searchLog');
  });

  test('detects transactional data from order/customer fields plus a numeric amount', () => {
    const rows = [
      { orderId: 'A1', customerId: 'C1', amount: 100 },
      { orderId: 'A2', customerId: 'C2', amount: 250 },
    ];
    const columns = columnsFor(rows, 'csv');
    const result = detectDatasetPatterns({ rows, columns, format: 'csv', originalName: 'orders.csv' });

    expect(result.transactional.matched).toBe(true);
  });

  test('detects time-series data from a date column plus a numeric column', () => {
    const rows = [
      { day: '2024-01-01', temperature: 10 },
      { day: '2024-01-02', temperature: 12 },
      { day: '2024-01-03', temperature: 9 },
    ];
    const columns = columnsFor(rows, 'csv');
    const result = detectDatasetPatterns({ rows, columns, format: 'csv', originalName: 'weather.csv' });

    expect(result.timeSeries.matched).toBe(true);
  });

  test('falls back to tabular for plain flat data with no other signal', () => {
    const rows = [
      { fruit: 'apple', color: 'red' },
      { fruit: 'banana', color: 'yellow' },
    ];
    const columns = columnsFor(rows, 'csv');
    const result = detectDatasetPatterns({ rows, columns, format: 'csv', originalName: 'fruit.csv' });

    expect(result.tabular.matched).toBe(true);
    expect(result.primary).toBe('tabular');
  });

  test('returns the empty/unknown shape for no rows or no columns', () => {
    expect(detectDatasetPatterns({ rows: [], columns: [], format: 'csv', originalName: '' }).primary).toBe('unknown');
  });
});

// ------------------------------------------------------------
// parseCsv
// ------------------------------------------------------------

describe('parseCsv', () => {
  test('parses a basic comma-separated file', () => {
    const rows = parseCsv('name,age\nAlice,30\nBob,25');
    expect(rows).toEqual([
      { name: 'Alice', age: '30' },
      { name: 'Bob', age: '25' },
    ]);
  });

  test('parses tab-separated content', () => {
    const rows = parseCsv('name\tage\nAlice\t30');
    expect(rows).toEqual([{ name: 'Alice', age: '30' }]);
  });

  test('handles quoted fields containing commas and escaped quotes', () => {
    const rows = parseCsv('name,bio\n"Doe, Jane","Says ""hi"" a lot"');
    expect(rows).toEqual([{ name: 'Doe, Jane', bio: 'Says "hi" a lot' }]);
  });

  test('fills missing trailing values with null instead of crashing on ragged rows', () => {
    const rows = parseCsv('a,b,c\n1,2\n1,2,3,4');
    expect(rows[0]).toEqual({ a: '1', b: '2', c: null });
    expect(rows[1]).toEqual({ a: '1', b: '2', c: '3' }); // extra trailing value is dropped, not crashed on
  });

  test('auto-names blank headers and de-duplicates repeated ones', () => {
    const rows = parseCsv('name,,name\nAlice,x,y');
    const keys = Object.keys(rows[0]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3); // no silently-overwritten column
  });

  test('skips blank lines and returns [] for empty content', () => {
    expect(parseCsv('a,b\n\nAlice,30\n\n')).toEqual([{ a: 'Alice', b: '30' }]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('   ')).toEqual([]);
  });

  test('throws a clear ProfilingValidationError when there are no headers at all', () => {
    expect(() => parseCsv(',,,\nvalue1,value2')).toThrow(ProfilingValidationError);
  });
});

// ------------------------------------------------------------
// parseJson
// ------------------------------------------------------------

describe('parseJson', () => {
  test('parses a JSON array of objects as-is', () => {
    expect(parseJson('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test('wraps a single JSON object into a one-row array', () => {
    expect(parseJson('{"a":1}')).toEqual([{ a: 1 }]);
  });

  test('wraps a bare JSON primitive', () => {
    expect(parseJson('42')).toEqual([{ value: 42 }]);
  });

  test('returns [] for empty content', () => {
    expect(parseJson('')).toEqual([]);
    expect(parseJson('   ')).toEqual([]);
  });

  test('throws a clear ProfilingValidationError on invalid JSON instead of a raw SyntaxError', () => {
    expect(() => parseJson('{not valid json')).toThrow(ProfilingValidationError);
    try {
      parseJson('{not valid json');
    } catch (error) {
      expect(error.message).toMatch(/Invalid JSON file/);
    }
  });
});

// ------------------------------------------------------------
// detectFormatFromName
// ------------------------------------------------------------

describe('detectFormatFromName', () => {
  test('detects csv/tsv/json by extension, case-insensitively', () => {
    expect(detectFormatFromName('data.CSV')).toBe('csv');
    expect(detectFormatFromName('data.tsv')).toBe('tsv');
    expect(detectFormatFromName('data.JSON')).toBe('json');
    expect(detectFormatFromName('data.txt')).toBe('unknown');
  });
});

// ------------------------------------------------------------
// profileFile (integration through the filesystem)
// ------------------------------------------------------------

describe('profileFile', () => {
  test('profiles a real CSV file end-to-end', () => {
    const filePath = writeTempFile('customers.csv', 'id,name,signupDate\n1,Alice,2024-01-01\n2,Bob,2024-02-01\n');
    const result = profileFile(filePath, 'customers.csv');

    expect(result.format).toBe('csv');
    expect(result.rowCount).toBe(2);
    expect(result.columnCount).toBe(3);
    expect(result.datasetPatterns.tabular.matched).toBe(true);
  });

  test('profiles a real nested JSON file end-to-end', () => {
    const data = JSON.stringify([
      { orderId: 'O1', customer: { name: 'Alice', address: { city: 'NYC' } }, items: ['pen', 'paper'] },
      { orderId: 'O2', customer: { name: 'Bob', address: { city: 'LA' } }, items: ['book'] },
    ]);
    const filePath = writeTempFile('orders.json', data);
    const result = profileFile(filePath, 'orders.json');

    expect(result.format).toBe('json');
    expect(result.hasNestedData).toBe(true);
    expect(result.datasetPatterns.nestedDocument.matched).toBe(true);

    const customerColumn = result.columns.find((c) => c.column === 'customer');
    expect(customerColumn.type).toBe('Object');

    const itemsColumn = result.columns.find((c) => c.column === 'items');
    expect(itemsColumn.type).toBe('Array');
  });

  test('throws ProfilingValidationError for an unsupported file type', () => {
    const filePath = writeTempFile('notes.txt', 'just some text');
    expect(() => profileFile(filePath, 'notes.txt')).toThrow(ProfilingValidationError);
  });

  test('throws ProfilingValidationError for invalid JSON content', () => {
    const filePath = writeTempFile('broken.json', '{not valid json');
    expect(() => profileFile(filePath, 'broken.json')).toThrow(ProfilingValidationError);
  });

  test('handles a genuinely empty CSV file without throwing', () => {
    const filePath = writeTempFile('empty.csv', '');
    const result = profileFile(filePath, 'empty.csv');
    expect(result.isEmpty).toBe(true);
    expect(result.rowCount).toBe(0);
  });
});
