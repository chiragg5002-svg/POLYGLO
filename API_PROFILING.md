# Data Profiling API

`POST /profile` — upload a CSV, TSV, or JSON file and get back a structured
profile of its rows/columns: types, nulls, cardinality, numeric/date/boolean
stats, nested-JSON structure, and a best-guess data pattern (transactional,
nested document, search/log, time-series, or tabular). Implemented in
`data-profiler.js`.

## Request

```
POST /profile
Content-Type: multipart/form-data

datasetFile: <file>   # .csv, .tsv, or .json, max 25MB
```

## Response

```json
{
  "success": true,
  "message": "Dataset profiling completed.",
  "profile": { ... }   // see "Profile object" below
}
```

On failure:

```json
{ "success": false, "message": "Profiling error: <details>" }
```

- **`400`** — the upload itself is unusable: invalid JSON syntax, a CSV with
  no header row, or an unsupported file extension.
- **`500`** — anything unexpected (e.g. a filesystem error reading the
  temp upload).

## Profile object

```jsonc
{
  "dataset": "orders.json",          // the uploaded file's original name
  "format": "csv" | "tsv" | "json" | "unknown",
  "isEmpty": false,                  // true for a genuinely empty file (0 data rows)
  "rowCount": 3,
  "columnCount": 7,
  "hasNestedData": true,             // true if any column is Object/Array/Nested
  "warnings": [],                    // non-fatal notes — see "Warnings" below
  "datasetPatterns": {
    "nestedDocument": { "matched": true,  "reason": "..." },
    "searchLog":      { "matched": false, "reason": "" },
    "timeSeries":      { "matched": true,  "reason": "..." },
    "transactional":   { "matched": true,  "reason": "..." },
    "tabular":         { "matched": false, "reason": "" },
    "primary": "nestedDocument"
  },
  "columns": [ /* one entry per column — see "Column object" below */ ]
}
```

### Column object

Every column always has this base shape:

| Field               | Type            | Notes |
|---------------------|-----------------|-------|
| `column`            | string          | Field/header name |
| `type`              | string          | `Boolean`, `Numeric`, `Date`, `Text`, `Mixed`, `Object`, `Array`, `Nested`, or `Unknown` (all values missing) |
| `totalValues`       | number          | = `rowCount` |
| `missingCount`      | number          | `null`/`undefined`/blank-string values. An empty array/object (`[]`, `{}`) is **not** missing — it's a present, empty value |
| `missingPercentage` | number          | 0–100, 2dp |
| `uniqueValues`      | number          | Distinct values, compared by content (not `String()`) so distinct nested objects don't collapse into one bucket |
| `cardinality`       | number          | `uniqueValues / totalValues`, 0–1 |
| `quality`           | string          | `EXCELLENT` (0% missing) / `GOOD` (≤5%) / `FAIR` (≤20%) / `POOR` (>20%) |
| `isNested`          | boolean         | true when `type` is `Object`, `Array`, or `Nested` |
| `nestedType`        | string \| null  | `"object"`, `"array"`, `"mixed"`, or `null` |
| `sampleValues`      | array           | Up to 5 distinct, non-missing raw values (can be objects/arrays for JSON) |

Additional fields depending on `type`:

- **`Numeric`**: `min`, `max`, `average`, `median`, `stdDev`, `pattern` (`RIGHT-SKEWED` / `LEFT-SKEWED` / `ROUGHLY-SYMMETRIC` / `INSUFFICIENT_DATA`)
- **`Date`**: `earliestDate`, `latestDate` (both `YYYY-MM-DD`), `timeSpanDays`, `pattern` (`TEMPORAL`)
- **`Boolean`**: `trueCount`, `falseCount`, `truePercentage`

### `datasetPatterns`

Each of the five patterns is evaluated independently (a dataset can match
more than one) and reports `matched` + a human-readable `reason`.
`primary` picks one, in this precedence order:
`nestedDocument > searchLog > timeSeries > transactional > tabular`.

| Pattern | Rule of thumb |
|---|---|
| `nestedDocument` | JSON file with at least one `Object`/`Array`/`Nested` column |
| `searchLog` | ≥2 of `timestamp/level/message/service/log/event` field names present, or search-y text fields (`title/content/description/search/article/document`) |
| `timeSeries` | A `Date` column with real time spread, alongside a `Numeric` column, over ≥3 rows |
| `transactional` | `order/customer/invoice/payment/user/account`-style field names alongside a numeric field |
| `tabular` | Flat data with no nested columns (the default shape for CSV, and for JSON with no nested fields) |

These rules mirror the deterministic routing rules already used by
`POST /routing/recommend` (`server.js`) and `inferRoutingRecommendation`
(`database-service.js`), so a dataset gets a consistent read whether it's
being profiled or routed.

### Warnings

`warnings` is a list of short, non-fatal notes about how the upload was
interpreted, e.g.:

- `"N row(s) were not JSON objects (e.g. plain arrays or primitive values) and were wrapped into a single "value" column so they could still be profiled."`
  — happens when a JSON file is a bare array of primitives/arrays rather
  than an array of objects.

An empty `warnings` array means nothing unusual was encountered.

## Known limitations

- **CSV quoting**: quoted fields (including embedded delimiters and `""`
  escaped quotes) are supported, but a quoted field containing a literal
  newline is not — rows are split on line breaks before quote parsing
  begins.
- **Type detection is per-column and threshold-based**: a column is
  classified as `Boolean`/`Numeric`/`Date` when ≥95% of its non-missing
  values fit that type; below that, and if at least two of those types
  are meaningfully present, it's reported as `Mixed` rather than silently
  defaulting to `Text`.
- Only `.csv`, `.tsv`, and `.json` are supported. Anything else, or a CSV
  with no header row, or malformed JSON, returns a `400` before any
  profiling is attempted.

## Examples

See `IMPLEMENTATION_STATUS.md` for a worked CSV example and a worked
nested-JSON example (with full response payloads).
