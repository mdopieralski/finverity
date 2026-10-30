---
name: local-run
description: >-
  Running the service locally with one command: docker compose with Postgres, Redpanda (and why not full
  Kafka), the service built from the Dockerfile, migrations and seeds on start, env vars, minting a token, the
  curl walk-through, sending treasury messages, and the cold-start check a reviewer will do. Use for
  docker-compose.yml, Dockerfile, .env.example, seeds, or "run it", "start the stack", "it doesn't start",
  "give me a curl".
---

# Local run

Owner: the `platform-engineer` agent. **Graded requirement in practice:** a reviewer who cannot start it stops
reading.

## The one command

```bash
docker compose up --build
```

brings up, in order:

1. `postgres` (official image, pinned major, healthcheck `pg_isready`, named volume).
2. `redpanda` (pinned version, single node, `--mode dev-container`, healthcheck `rpk cluster health`), plus a
   one-shot `redpanda-init` that creates `treasury.capacity.v1` (or the consumer creates it; pick one).
3. `api` built from the `Dockerfile` (multi-stage: pnpm install with the lockfile → `nest build` → slim Node
   22 runtime, non-root user). `depends_on` with `condition: service_healthy`. On start: run migrations, run
   the idempotent seed, then listen on `:3000`.

No healthcheck on the API needs an open HTTP route (every route needs a JWT).

**Redpanda instead of Kafka** (README "Assumptions and trade-offs"): Kafka-protocol compatible, one container
instead of Kafka + ZooKeeper/KRaft config, starts in seconds. The client code is the same against Kafka.

## Env

`.env.example` lists every variable with a safe local default; compose sets the same values inline so
`docker compose up` works without copying anything. `JWT_SECRET` local default is clearly a dev value
(`dev-only-change-me`). Real secrets never go in the repo; the pre-edit hook blocks writing `.env`.

## Seeds (idempotent, `ON CONFLICT DO NOTHING`)

At least two currencies, one with a zero exponent (scf-domain skill personas): `prg_eur_acme` (EUR),
`prg_usd_globex` (USD), `prg_jpy_umbrella` (JPY). Each with a `PROGRAM_OPENED` ledger entry so the ledger
alone explains the starting limit. A fixed FX table covering every seeded pair both ways.

## Where things are (the README's "What / Where" table)

| What           | Where                                 | Auth                                          |
| -------------- | ------------------------------------- | --------------------------------------------- |
| API            | `http://localhost:3000`               | `Authorization: Bearer $TOKEN`                |
| Swagger UI     | `http://localhost:3000/docs`          | browser prompt: any user, password = `$TOKEN` |
| OpenAPI (JSON) | `http://localhost:3000/openapi.json`  | Bearer                                        |
| Exported spec  | `docs/api/openapi.json` (in the repo) | none: a file                                  |

Compose sets `API_DOCS=1`; the service's default is off.

## Reviewer walk-through (the README's Quick start, verified on every change to compose)

```bash
docker compose up --build -d
TOKEN=$(pnpm run -s token)          # or: docker compose exec api node dist/scripts/mint-token.js
curl -s localhost:3000/programs/prg_eur_acme/availability -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:3000/programs/prg_eur_acme/reservations \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: demo-1" -H 'Content-Type: application/json' \
  -d '{"invoiceRef":"INV-1001","amountMinor":"1250000","currency":"USD"}'
# same again → same response (replay); change the amount → 409
curl -s -X POST localhost:3000/reservations/<id>/release -H "Authorization: Bearer $TOKEN"
pnpm run produce -- snapshot prg_eur_acme --seq 2 --limit 900000000 --utilised 0
```

Then open `/docs`, paste the token as the password, and _Try it out_ each endpoint (Authorize is pre-set).

The token must also work without a local Node install: provide the in-container variant.

`scripts/ci-smoke.sh` (yours) automates this walk-through for CI and locally (the `ci-pipeline` skill).

## Cold-start check (before saying "it runs")

```bash
docker compose down -v            # the pre-bash hook asks the user first: it wipes local data
docker compose up --build -d && docker compose ps     # all healthy
docker compose logs api --tail 50                     # migrations ran, seeds ran, consumer joined the group
```

then every curl from the README, copied from the README (not from memory). Time it; say how long the first
build took.
