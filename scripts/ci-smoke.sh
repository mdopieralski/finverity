#!/usr/bin/env bash
# The reviewer's walk-through, automated: one command up, a token, the README's calls, /docs, a Kafka
# snapshot. Same locally (`bash scripts/ci-smoke.sh`) and in CI. Leaves the stack running on success
# locally; CI throws the runner away.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "SMOKE FAILED: $*"; docker compose logs --tail 200 api || true; exit 1; }
expect() { [[ "$2" == "$3" ]] || fail "$1: expected $3, got $2"; echo "ok  $1 ($2)"; }

docker compose up --build -d
for _ in $(seq 1 60); do
  [[ "$(docker compose ps api --format '{{.Health}}')" == "healthy" ]] && break
  sleep 2
done
[[ "$(docker compose ps api --format '{{.Health}}')" == "healthy" ]] || fail "api never became healthy"

TOKEN=$(docker compose exec -T api node dist/scripts/mint-token.js)
API=http://localhost:3000
auth=(-H "Authorization: Bearer $TOKEN")
json=(-H 'Content-Type: application/json')
key="smoke-$(date +%s)-$RANDOM"
body='{"invoiceRef":"INV-SMOKE","amountMinor":"1250000","currency":"USD"}'

expect "availability without a token" "$(curl -s -o /dev/null -w '%{http_code}' $API/programs/prg_eur_acme/availability)" 401
expect "availability" "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" $API/programs/prg_eur_acme/availability)" 200
created=$(curl -s -w '\n%{http_code}' "${auth[@]}" "${json[@]}" -H "Idempotency-Key: $key" -d "$body" $API/programs/prg_eur_acme/reservations)
expect "reserve" "$(tail -1 <<<"$created")" 201
id=$(head -1 <<<"$created" | sed -E 's/.*"id":"([^"]+)".*/\1/')
expect "replay" "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "${json[@]}" -H "Idempotency-Key: $key" -d "$body" $API/programs/prg_eur_acme/reservations)" 201
expect "same key, different body" "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "${json[@]}" -H "Idempotency-Key: $key" -d "${body/1250000/1250001}" $API/programs/prg_eur_acme/reservations)" 409
expect "fractional amount" "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "${json[@]}" -H "Idempotency-Key: $key-x" -d "${body/1250000/1500.50}" $API/programs/prg_eur_acme/reservations)" 400
expect "release" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${auth[@]}" $API/reservations/$id/release)" 200
expect "/openapi.json without a token" "$(curl -s -o /dev/null -w '%{http_code}' $API/openapi.json)" 401
expect "/openapi.json" "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" $API/openapi.json)" 200
expect "/docs without credentials" "$(curl -s -o /dev/null -w '%{http_code}' $API/docs/)" 401
expect "/docs with the token as password" "$(curl -s -o /dev/null -w '%{http_code}' -u "reviewer:$TOKEN" $API/docs/)" 200

msg="smoke-$RANDOM$RANDOM"
# Adjustments take exactly the next sequence number (a gap is rejected): read the current one first.
seq=$(curl -s "${auth[@]}" $API/programs/prg_usd_globex/availability | sed -E 's/.*"treasurySequence":"([0-9]+)".*/\1/')
[[ "$seq" =~ ^[0-9]+$ ]] || fail "could not read treasurySequence"
printf '{"messageId":"%s","type":"ADJUSTMENT","programId":"prg_usd_globex","treasurySequence":"%s","currency":"USD","component":"UTILISED","deltaMinor":"1"}\n' \
  "$msg" "$((seq + 1))" | docker compose exec -T redpanda rpk topic produce treasury.capacity.v1 -k prg_usd_globex >/dev/null
for _ in $(seq 1 30); do
  docker compose logs api --no-log-prefix | grep -q "\"messageId\":\"$msg\".*\"outcome\":\"applied\"" && break
  sleep 1
done
docker compose logs api --no-log-prefix | grep -q "\"messageId\":\"$msg\".*\"outcome\":\"applied\"" || fail "treasury message not applied"
echo "ok  treasury message applied via Redpanda"
echo "SMOKE PASSED"
