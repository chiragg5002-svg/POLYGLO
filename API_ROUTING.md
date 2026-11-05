# Database Routing Recommendation API

`POST /routing/recommend` — given a dataset (uploaded content or raw rows),
returns which backing store it should go to: `postgres`, `mongodb`,
`elasticsearch`, or `local`. Implemented in `routing-engine.js`.

## How the recommendation is made (hybrid pipeline)

1. **Deterministic rules first.** If a rule is confident, its answer is
   returned immediately — Ollama is never called.
2. **Local Ollama second**, only when no rule is confident.
3. **LLM output is validated** against the allowed targets before it's
   trusted at all.
4. **Safety net**: even a validated Ollama answer is rejected if it
   recommends Postgres for data that looks like logs/search/nested JSON —
   the rule-based answer wins instead.
5. **Safe fallback**: if Ollama is unreachable or returns something
   unusable, the rule-based default is returned instead of failing.

## Request

```
POST /routing/recommend
Content-Type: application/json

{ "originalName": "orders.csv", "content": "<raw file text>" }
```

or, with already-parsed rows instead of raw file content:

```json
{ "originalName": "orders.json", "rows": [{ "orderId": "A1", "amount": 100 }] }
```

## Response

```json
{
  "target": "postgres" | "mongodb" | "elasticsearch" | "local",
  "confidence": "high" | "medium" | "low",
  "reason": "human-readable explanation",
  "pattern": "nestedDocument" | "applicationLogs" | "fullTextSearch" | "transactional" | "possibleSearchOrLogData" | "tabular",
  "source": "rules" | "ollama" | "fallback",
  "suggestedCollection": "sanitized_name_derived_from_the_filename"
}
```

`source` tells you exactly how the decision was made:

- **`rules`** — a deterministic rule was confident enough to decide on its
  own (Ollama wasn't called), **or** Ollama's answer was overridden because
  it was unsafe (e.g. Postgres for log-like data).
- **`ollama`** — the deterministic rules weren't confident, Ollama was
  consulted, and its (validated) answer didn't conflict with anything
  unsafe, so it was used as-is.
- **`fallback`** — Ollama was unreachable, timed out, or returned something
  that couldn't be validated as a real recommendation, so the rule-based
  default was used instead.

## Deterministic rules (in precedence order)

| Order | Pattern | Target | Trigger |
|---|---|---|---|
| 1 | `nestedDocument` | `mongodb` | JSON file with at least one field holding a nested object or array |
| 2 | `applicationLogs` | `elasticsearch` | ≥2 of `timestamp`/`level`/`message`/`service`/`log`/`event` field names present |
| 3 | `fullTextSearch` | `elasticsearch` | ≥2 of `title`/`content`/`description`/`text` field names present, or ≥1 plus search-related sample text/filename |
| 4 | `transactional` | `postgres` | `order`/`customer`/`invoice`/`payment`/`user`/`account` appears in a **column name** (not row values — see note below) |
| 5 | `possibleSearchOrLogData` | `elasticsearch` (weak) | Exactly one log or full-text field name matched — not confident enough to skip Ollama, but Postgres is never allowed to win over this signal |
| 6 | `tabular` | `postgres` (weak) | None of the above — the default assumption for plain structured/flat data |

Patterns 1–4 are "strong": they decide the result outright without calling
Ollama. Patterns 5–6 are "weak": Ollama is consulted, but pattern 5 also
activates the Postgres-blocking safety net described above.

**Why the transactional rule only checks column names:** matching against
row values too would let an incidental word inside unrelated text (e.g. the
word "user" inside a log message like `"user login failed"`) falsely trigger
a transactional match and mask real log data — this was found and fixed
during this rewrite.

## Examples

See `IMPLEMENTATION_STATUS.md` for a full worked example (`application_logs.json`
→ Elasticsearch, decided by rules alone) and the Ollama-unavailable fallback
case, both captured from a live server response.
