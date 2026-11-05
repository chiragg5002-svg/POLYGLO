#!/usr/bin/env bash
# End-to-end demo of the DBaaS API (needs a running server).
#   MAESTRO_ADMIN_TOKEN=... BASE=http://localhost:3000 ./scripts/demo.sh
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
ADMIN="${MAESTRO_ADMIN_TOKEN:?set MAESTRO_ADMIN_TOKEN}"
j() { node -pe "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));$1"; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "1. Create a project (the API key is shown ONCE)"
P=$(curl -sS -X POST "$BASE/v1/projects" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -H "Idempotency-Key: demo-$(date +%s%N)" -d '{"name":"Demo shop"}')
PID=$(echo "$P" | j 'd.projectId'); KEY=$(echo "$P" | j 'd.apiKey'); echo "project $PID  key ${KEY:0:20}..."

say "2. Dry-run a CSV import (nothing is written; shows inferred schema + where it would live)"
cat > /tmp/demo-products.csv <<CSV
sku,name,price,in_stock
a1,Laptop,75000.5,true
a2,Phone,30000,true
a3,"Cable, USB-C",199,false
CSV
curl -sS -X POST "$BASE/v1/import" -H "Authorization: Bearer $KEY" -F collection=products -F dryRun=true -F file=@/tmp/demo-products.csv | j '({status:d.status,routing:d.routing,summary:d.summary})'

say "3. Import it for real (idempotent: idField + onDuplicate=skip)"
curl -sS -X POST "$BASE/v1/import" -H "Authorization: Bearer $KEY" -F collection=products -F idField=sku -F onDuplicate=skip -F file=@/tmp/demo-products.csv | j '({status:d.status,summary:d.summary})'
echo "re-running the same file inserts nothing new:"
curl -sS -X POST "$BASE/v1/import" -H "Authorization: Bearer $KEY" -F collection=products -F idField=sku -F onDuplicate=skip -F file=@/tmp/demo-products.csv | j '({status:d.status,summary:d.summary})'

say "4. Query (second identical query is served from Redis when available)"
Q='{"collection":"products","filters":{"price":{"gte":1000}},"sort":{"field":"price","direction":"asc"}}'
curl -sS -X POST "$BASE/v1/query" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$Q" | j '({cached:d.cached,count:d.resultCount,names:d.results.map(r=>r.data.name)})'
curl -sS -X POST "$BASE/v1/query" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$Q" | j '({cached:d.cached})'

say "5. Least privilege: a read-only key cannot write"
RO=$(curl -sS -X POST "$BASE/v1/projects/$PID/keys" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"label":"reporting","scopes":["data:read"],"expiresInDays":30}' | j 'd.apiKey')
curl -sS -X POST "$BASE/v1/data" -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"collection":"products","data":{"sku":"x"}}' | j '({code:d.error.code,message:d.error.message})'

say "6. Usage, quotas and the audit trail"
curl -sS "$BASE/v1/usage" -H "Authorization: Bearer $KEY" | j '({usage:d.usage,quotas:d.quotas,collections:d.collections})'
curl -sS "$BASE/v1/audit?projectId=$PID&limit=5" -H "Authorization: Bearer $ADMIN" | j 'd.events.map(e=>e.action+" by "+e.actor)'

say "7. Rotate the read-only key with a 60s grace period, then clean up"
curl -sS -X POST "$BASE/v1/projects/$PID/keys/$(curl -sS "$BASE/v1/projects/$PID" -H "Authorization: Bearer $ADMIN" | j 'd.apiKeys.find(k=>k.label==="reporting").keyId')/rotate" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"graceSeconds":60}' | j '({replaced:d.replaced,oldKeyValidForSeconds:d.oldKeyValidForSeconds,scopes:d.scopes})'
curl -sS -X DELETE "$BASE/v1/projects/$PID?purge=true" -H "Authorization: Bearer $ADMIN" | j '({deleted:d.deleted,dataPurged:d.dataPurged,stores:d.stores})'
