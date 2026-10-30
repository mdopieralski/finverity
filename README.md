<div align="center">

# program-capacity

**Real-time credit capacity for supply chain finance programs: reserve on early payment, release on
repayment.**

Never oversubscribed under concurrency, safe to retry, and a late treasury snapshot can't roll it back or
erase what it reserved.

![Node 22](https://img.shields.io/badge/node-22-339933?logo=node.js&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![NestJS 12](https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white)
![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Kafka API (Redpanda)](https://img.shields.io/badge/Kafka%20API-Redpanda-231F20?logo=apachekafka&logoColor=white)
![OpenAPI](https://img.shields.io/badge/OpenAPI-3.0-6BA539?logo=openapiinitiative&logoColor=white)

[Quick start](#quick-start) · [API](#api) · [How it works](#how-it-works) ·
[Behaviour decisions](#behaviour-decisions) · [Assumptions](#assumptions-and-trade-offs) · [Testing](#testing)

</div>

```sh
curl -s -X POST localhost:3000/programs/prg_eur_acme/reservations \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: approval-INV-1001" -H 'Content-Type: application/json' \
  -d '{"invoiceRef":"INV-1001","amountMinor":"1250000","currency":"USD"}'
```

```json
{
  "id": "03b71fbd-6a68-48d0-8a57-82b362cdede9",
  "programId": "prg_eur_acme",
  "invoiceRef": "INV-1001",
  "status": "ACTIVE",
  "amountMinor": "1136364",
  "currency": "EUR",
  "exponent": 2,
  "invoice": { "amountMinor": "1250000", "currency": "USD" },
  "fx": { "rate": "0.909091", "rateAt": "2026-10-28T13:23:07.425Z", "source": "fixed-table" },
  "createdAt": "2026-10-28T13:23:11.570Z",
  "releasedAt": null
}
```

A USD 12,500.00 invoice reserved EUR 11,363.64 of a EUR program, converted once at the stored rate. Amounts
are integer minor units, as strings. Releasing it gives back exactly `1136364`, whatever the rate does next.

---

## Contents

1. [Quick start](#quick-start)
2. [API](#api)
3. [How it works](#how-it-works)
4. [Behaviour decisions](#behaviour-decisions)
5. [Assumptions and trade-offs](#assumptions-and-trade-offs)
6. [Testing](#testing)
7. [Development](#development): stack, project structure, environment, scripts, CI
8. [Limitations and next steps](#limitations-and-next-steps)

---

## Quick start

**You need:** Docker. (Node 22 and pnpm 10 only to run the tests or the scripts on the host.)

```sh
docker compose up --build
```

Postgres, Redpanda and the service start; migrations run; three demo programs are seeded: `prg_eur_acme` (EUR
10,000,000.00), `prg_usd_globex` (USD 5,000,000.00), `prg_jpy_umbrella` (¥500,000,000). First build ≈ 1–2 min,
later starts ≈ 15 s.

| What           | Where                                            | Auth                                                |
| -------------- | ------------------------------------------------ | --------------------------------------------------- |
| API            | `http://localhost:3000`                          | `Authorization: Bearer $TOKEN`                      |
| Swagger UI     | `http://localhost:3000/docs`                     | the browser asks: any username, password = `$TOKEN` |
| OpenAPI (JSON) | `http://localhost:3000/openapi.json`             | Bearer                                              |
| Exported spec  | [`docs/api/openapi.json`](docs/api/openapi.json) | none: a file in the repo                            |

**Get a token** (HS256, signed with the dev `JWT_SECRET` compose uses, valid 1 h):

```sh
export TOKEN=$(docker compose exec -T api node dist/scripts/mint-token.js)   # no Node needed on the host
# or, with Node + pnpm:  pnpm install && pnpm run build && export TOKEN=$(pnpm run -s token)
```

### Try it

```sh
H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

# Availability
curl -s localhost:3000/programs/prg_eur_acme/availability "${H[@]}"
# 200 {"programId":"prg_eur_acme","currency":"EUR","exponent":2,"creditLimitMinor":"1000000000","treasuryUtilisedMinor":"0","reservedMinor":"0","availableMinor":"1000000000","treasurySequence":"0","asOf":null}

# Reserve a USD invoice on the EUR program (the response above), then retry it: same answer, nothing reserved twice
curl -s localhost:3000/programs/prg_eur_acme/reservations "${H[@]}" -H 'Idempotency-Key: approval-INV-1001' \
  -d '{"invoiceRef":"INV-1001","amountMinor":"1250000","currency":"USD"}' -D - -o /dev/null | grep -i replayed
# Idempotent-Replayed: true     (status 201, identical body)

# Same key, different body
curl -s localhost:3000/programs/prg_eur_acme/reservations "${H[@]}" -H 'Idempotency-Key: approval-INV-1001' \
  -d '{"invoiceRef":"INV-1001","amountMinor":"9999999","currency":"USD"}'
# 409 {"error":{"code":"idempotency_key_reused","message":"Idempotency-Key was already used with a different request.","requestId":"…"}}

# A fractional amount
curl -s localhost:3000/programs/prg_eur_acme/reservations "${H[@]}" -H 'Idempotency-Key: approval-INV-1002' \
  -d '{"invoiceRef":"INV-1002","amountMinor":"1500.50","currency":"EUR"}'
# 400 {"error":{"code":"invalid_amount","message":"amountMinor must be a positive integer string in minor units.","requestId":"…","fields":["amountMinor"]}}

# One yen over the JPY program's limit
curl -s localhost:3000/programs/prg_jpy_umbrella/reservations "${H[@]}" -H 'Idempotency-Key: approval-INV-1003' \
  -d '{"invoiceRef":"INV-1003","amountMinor":"500000001","currency":"JPY"}'
# 422 {"error":{"code":"insufficient_capacity","message":"Insufficient capacity on this program.","requestId":"…"}}

# Release on repayment: exactly the reserved amount comes back
curl -s -X POST localhost:3000/reservations/<id>/release -H "Authorization: Bearer $TOKEN"
# 200 {…,"status":"RELEASED","amountMinor":"1136364",…,"releasedAt":"2026-10-28T13:23:11.660Z"}
curl -s localhost:3000/programs/prg_eur_acme/availability "${H[@]}"
# 200 {…,"reservedMinor":"0","availableMinor":"1000000000",…}

# List, paginated; availability at a past instant (recomputed from the ledger)
curl -s "localhost:3000/programs/prg_eur_acme/reservations?status=ACTIVE&limit=20" "${H[@]}"
curl -s "localhost:3000/programs/prg_eur_acme/availability?asOf=2026-10-28T13:23:11.600Z" "${H[@]}"

# No token
curl -s localhost:3000/programs/prg_eur_acme/availability
# 401 {"error":{"code":"unauthenticated","message":"Authentication required.","requestId":"…"}}
```

**Send treasury messages** (as the treasury system would, over Kafka):

```sh
pnpm run produce -- snapshot prg_eur_acme --seq 5 --limit 900000000 --utilised 100000000 --id tre-demo-5
pnpm run produce -- snapshot prg_eur_acme --seq 5 --limit 900000000 --utilised 100000000 --id tre-demo-5  # redelivery
pnpm run produce -- snapshot prg_eur_acme --seq 4 --limit 1 --utilised 0 --id tre-demo-4                  # older
docker compose logs api | grep 'treasury message'
# … "messageId":"tre-demo-5", … "outcome":"applied" …
# … "messageId":"tre-demo-5", … "outcome":"duplicate" …
# … "messageId":"tre-demo-4", … "outcome":"stale","detail":"sequence 4 <= applied 5" …
```

Without Node on the host:
`docker compose exec -T redpanda rpk topic produce treasury.capacity.v1 -k prg_eur_acme` and paste one JSON
message per line (format in [How it works](#treasury-messages)).

**Swagger UI:** open `http://localhost:3000/docs`, enter any username and the token as the password.
_Authorize_ is pre-set for _Try it out_ (paste the same token there once).

**Run the whole reviewer walk-through automatically:** `bash scripts/ci-smoke.sh` (what CI runs). **Something
stuck?** `docker compose down -v && docker compose up --build`.

---

## API

| Method | Path                         | Purpose                                                                                |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------- |
| `POST` | `/programs/:id/reservations` | Reserve capacity for an invoice approved for early payment. `Idempotency-Key` required |
| `POST` | `/reservations/:id/release`  | Release a reservation on repayment                                                     |
| `GET`  | `/programs/:id/availability` | Current availability; `?asOf=<ISO-8601 instant>` recomputes it from the ledger         |
| `GET`  | `/programs/:id/reservations` | List reservations, newest first: `?status=ACTIVE\|RELEASED&limit=1..100&cursor=`       |
| `GET`  | `/docs`, `/openapi.json`     | Swagger UI and the OpenAPI document (also behind the JWT)                              |

The spec is generated from the `@nestjs/swagger` decorators and checked against the code:
`test/docs.contract.spec.ts` validates real responses against it, every documented error message against the
error table, and the served spec against the committed [`docs/api/openapi.json`](docs/api/openapi.json). CI
fails if the export is stale (`pnpm run docs:check`) or Redocly rejects it (`pnpm run docs:lint`).

### Money format

> [!IMPORTANT] Every amount is a **string of integer minor units** in the currency next to it. EUR 12,500.00
> is `"1250000"`; ¥500 is `"500"`. Fractions (`"1500.50"`), JSON numbers (`1500`), exponents, zero and
> negatives are rejected with 400 `invalid_amount`. Responses add `exponent` so a client can format them.

| Currency                | Exponent | Currency | Exponent |
| ----------------------- | -------- | -------- | -------- |
| EUR, USD, GBP, PLN, CHF | 2        | JPY      | 0        |

A reservation in another currency than the program's is converted into the program currency **once, at
reservation time**, rounded **up** to the next minor unit; the rate, its timestamp and its source are stored
and returned in `fx`. A release gives back exactly `amountMinor`, never reconverted.

### Reservations

`POST /programs/:id/reservations` with `{"invoiceRef", "amountMinor", "currency"}` and an `Idempotency-Key`
header (1–255 printable ASCII characters, scoped to the token's `sub`):

| Same key + …                   | Result                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| same body                      | the original status and body, header `Idempotent-Replayed: true`, nothing written         |
| different body                 | 409 `idempotency_key_reused`                                                              |
| first try 422                  | 422 again: a key names one approval attempt and its answer is final; retry with a new key |
| first try 404 / FX unavailable | not stored (nothing was reserved); a retry may succeed                                    |

`POST /reservations/:id/release` is idempotent by state: a second release returns the same released
reservation, 200.

### Errors

Every error is `{ "error": { "code", "message", "requestId", "fields"? } }`. Messages are fixed strings per
code; `fields` names offending fields, never their values. Internal detail (SQL, driver errors, stacks) goes
to the log only.

| Status | Code                                                            | When                                                                       |
| ------ | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 400    | `invalid_request`, `invalid_amount`, `idempotency_key_required` | malformed JSON, unknown fields or query parameters, bad ids, future `asOf` |
| 401    | `unauthenticated`                                               | missing, forged, expired or `sub`-less token                               |
| 404    | `program_not_found`, `reservation_not_found`, `route_not_found` |                                                                            |
| 409    | `idempotency_key_reused`                                        | same key, different body                                                   |
| 422    | `insufficient_capacity`, `fx_rate_unavailable`                  | a valid request the program cannot take                                    |
| 503    | `service_unavailable`                                           | the database is unreachable                                                |
| 500    | `internal`                                                      | anything else (logged with detail)                                         |

Every response carries `X-Request-Id`: the caller's if it matches `^[\w.-]{1,128}$`, else a new UUID.

---

## How it works

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant API as Nest API
  participant T as Treasury (Kafka)
  participant K as Consumer
  participant DB as Postgres

  C->>API: POST reservation + JWT + Idempotency-Key
  API->>DB: program currency, FX quote, convert once (no transaction yet)
  rect rgb(235, 245, 255)
  note over API,DB: one transaction
  API->>DB: INSERT idempotency_keys (same key waits here)
  API->>DB: UPDATE programs SET reserved += amt WHERE available >= amt
  API->>DB: INSERT reservation + ledger RESERVE row
  API->>DB: store the response under the key
  end
  API-->>C: 201 (or 422, replayed on retry)

  T->>K: SNAPSHOT / ADJUSTMENT (at-least-once)
  rect rgb(240, 255, 240)
  note over K,DB: one transaction
  K->>DB: INSERT processed_messages (duplicate → stop)
  K->>DB: SELECT program FOR UPDATE; sequence > applied? else stale
  K->>DB: ledger TREASURY_* delta rows + programs cache
  end
  K->>T: commit offset (only now)
```

### Data model

| Table                | Role                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger_entries`     | **Source of truth.** Append-only (a trigger rejects UPDATE/DELETE). Signed deltas per component: `TREASURY_LIMIT`, `TREASURY_UTILISED`, `LOCAL`                        |
| `programs`           | Cache of the ledger fold: `credit_limit_minor`, `treasury_utilised_minor`, `reserved_minor`, `treasury_sequence`. Changed only in the same transaction as a ledger row |
| `reservations`       | Invoice amount and currency, converted `amount_minor`, `fx_rate`, `fx_rate_at`, `fx_source`, status                                                                    |
| `idempotency_keys`   | `(subject, key)` → request hash and the stored response                                                                                                                |
| `processed_messages` | Treasury message id → outcome (`applied`, `stale`, `rejected`, `overcommitted`)                                                                                        |

`available = credit_limit − treasury_utilised − reserved`. Current availability reads the cache; `?asOf=`
folds the ledger up to that instant, which is what an auditor would do. Tests assert the cache equals the fold
after concurrent reserves, releases and snapshots.

### Treasury messages

Topic `treasury.capacity.v1`, key = program id, JSON, amounts and sequences as strings:

```json
{"messageId":"tre-7f3c","type":"SNAPSHOT","programId":"prg_eur_acme","treasurySequence":"57","currency":"EUR","creditLimitMinor":"900000000","treasuryUtilisedMinor":"100000000"}
{"messageId":"tre-8a01","type":"ADJUSTMENT","programId":"prg_eur_acme","treasurySequence":"58","currency":"EUR","component":"UTILISED","deltaMinor":"-250000"}
```

### Limits

| Limit               | Value                        | Why                                                                       |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| Amount              | 1 … 18 digits of minor units | fits Postgres `BIGINT` with headroom for sums                             |
| Page size           | 1–100, default 50            | bounded responses; keyset cursor on `(created_at, id)`                    |
| Idempotency key     | 1–255 printable ASCII        | room for UUIDs and composite approval ids                                 |
| DB pool             | `DB_POOL_SIZE`, default 20   | each in-flight reservation holds one connection for one short transaction |
| Timestamp precision | milliseconds                 | what JSON clients can send back as `asOf` or a cursor                     |

---

## Behaviour decisions

The four graded invariants first; each names the test that proves it.

- **No oversubscription: one conditional UPDATE.** The capacity check and the write are a single statement
  (`UPDATE programs SET reserved = reserved + $a WHERE id = $p AND limit − treasury − reserved >= $a`), with
  the reservation and ledger inserts in the same transaction. Postgres locks the row; a concurrent UPDATE
  waiting on it re-evaluates the `WHERE` against the committed row, so the second racer sees the first one's
  reservation. No row back means insufficient capacity: a business outcome (422), and nothing is written.
  Chosen over `SELECT … FOR UPDATE` because the decision lives in one statement instead of being split between
  SQL and TypeScript; optimistic locking with retries would be over-engineering. _Proof:_
  `N concurrent reservations against a limit that fits N-1 → exactly one is rejected…` (N = 25, 5 rounds, pool
  40), plus a control test showing the same load **does** oversubscribe a read-then-write guard, and a
  mutation run: removing the condition turns 5 tests red.
- **Idempotent HTTP.** The key row is inserted first in the reservation's transaction; a parallel request with
  the same key blocks on the primary key until the first commits, then replays its stored answer. A rejected
  attempt (422) is stored and replayed too: a key names one approval attempt and its answer is final, so a
  client retrying a timeout gets the answer that was given rather than a different one minutes later. Not
  stored: 404 and missing FX rate (nothing was reserved). _Proof:_
  `the same Idempotency-Key returns the original result`, 409 on a different body, 15 parallel requests with
  one key → one reservation.
- **Exactly-once Kafka by consumer-side dedup.** _The broker guarantees at-least-once, so exactly-once is
  achieved by consumer-side dedup, not by the broker._ The `processed_messages` row and the business effect
  are written in one transaction, deduped on treasury's message id (not the offset); auto-commit is off and
  the offset is committed only after that transaction commits. A crash in between means redelivery, which the
  dedup turns into a no-op. _Proof:_ `the same Kafka message is applied once` through a real Redpanda broker,
  and a forced handler failure that leaves the offset uncommitted and applies the message once on redelivery.
- **Reconciliation ordering.** A snapshot or adjustment applies only if its `treasurySequence` is strictly
  greater than the program's (equal is stale too), checked under `SELECT … FOR UPDATE`. It rebases only the
  treasury-owned component, written as ledger deltas; `reserved_minor` and `ACTIVE` reservations are never
  touched, so they stay on top of the new baseline. _Proof:_ `an older snapshot does not roll the state back`,
  `a snapshot does not wipe local active reservations`.
- **Convert once, release exactly.** The rate is fetched and applied before the transaction opens (so a slow
  rate source holds no lock), rounding up; the converted amount, the rate, its timestamp and its source are
  stored. Release gives back the stored `amount_minor` and never calls the rate source. _Proof:_
  `reserving at rate A and releasing after the rate moves to B returns availability to exactly its starting value`.
- **422, not 409, for insufficient capacity:** the request is valid and well-formed; the program can't take
  it.
- **Amounts are strings**, because JSON numbers become doubles in most clients (unsafe above 2^53, lossy for
  fractions). Money is `bigint` in code and `BIGINT` in Postgres; rates are exact decimal strings and
  `NUMERIC`.
- **The docs are behind the same JWT.** `/openapi.json` takes the Bearer token; `/docs` takes HTTP Basic with
  the token as the password (a browser cannot send a bearer header on page load, but resends Basic credentials
  for every asset). Swagger's routes sit outside Nest's guards, so a middleware covers every docs path,
  matched the way Express routes (case-insensitive, optional trailing slash).
- **`/docs` serves only what its page loads.** The page, its init script (the spec embedded, so the browser
  never needs credentials outside `/docs/`) and four named files from `swagger-ui-dist`. Anything else under
  `/docs/` is a 404, including the package's `package.json`, `README.md` and source maps, which Nest's
  `SwaggerModule.setup` would serve. Same pattern as the ingrid service.
- **A limit cut below utilisation is applied.** Treasury owns the limit: availability goes negative (outcome
  `overcommitted`), new reservations are rejected, existing ones are untouched.
- **Malformed treasury messages are recorded as `rejected` and acknowledged**, so one poison message cannot
  block its partition; a database outage is not recorded and not acknowledged, so the message is retried.
- **Logs:** one JSON line per request (`requestId`, `method`, `route`, `status`, `durationMs`, `outcome`,
  `programId`, `sub`) and one per treasury message (`messageId`, `type`, `sequence`, `outcome`). Never tokens
  or request bodies. `outcome` is one word: `reserved`, `replayed`, `released`, `read`, `rejected`, `invalid`,
  `conflict`, `not_found`, `unauthenticated`, `unavailable`, `error`, `docs`.

---

## Assumptions and trade-offs

- **Redpanda instead of Kafka in compose.** Kafka-protocol compatible, one container instead of Kafka plus
  ZooKeeper/KRaft configuration, healthy in seconds. The client code is the same against Apache Kafka; only
  Redpanda was tested.
- **A snapshot's `treasuryUtilisedMinor` excludes reservations made through this service**: they are
  re-applied on top. A real integration would agree this with treasury; if treasury included them, they would
  be counted twice.
- **Adjustments and snapshots share one per-program sequence** (treasury's version counter). An adjustment
  that arrives after a higher-numbered snapshot is stale.
- **FX:** a fixed local table (`FX_RATES`, or the built-in indicative rates), not market data. _Production
  would use a rate service with a defined fixing policy; fixing policy is a business decision, not an
  engineering one._ Rounding up when converting is a business assumption too (the reservation always covers
  the invoice).
- **`asOf` before a program existed returns zeros**, not 404: the program had no capacity then.
- **JWT:** HS256 with a shared `JWT_SECRET`, `sub` required, optional `iss`/`aud`. No roles or tenants. The
  local secret is a documented dev value.
- **NestJS 12, ESM, Vitest:** Nest 12 is ESM-only and its ESM template uses Vitest, so that is the framework's
  default runner here. Validation is hand-written instead of class-validator, and `pg` with SQL files instead
  of an ORM, to stay within the brief's dependency list. Details:
  [`docs/decisions/stack-2026-10-28.md`](docs/decisions/stack-2026-10-28.md).
- **Testcontainers** for the e2e suite (one Postgres per run, a fresh database per suite, Redpanda for the
  Kafka tests) rather than the compose database, so tests never touch the demo data.
- **Spec from decorators** (OpenAPI 3.0, what `@nestjs/swagger` emits) rather than a hand-written 3.1 file;
  the contract test and `docs:check` keep it honest.

---

## Testing

```sh
pnpm test            # unit (money conversion), no Docker, < 1 s
pnpm run test:e2e    # the graded specs: real HTTP, Postgres + Redpanda via Testcontainers, ≈ 25 s
```

| File                           | Proves                                                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capacity.concurrency.spec.ts` | **N concurrent reservations vs a limit for N-1 → exactly one rejected, sum ≤ limit**; one minor unit over writes nothing; mixed concurrent reserve/release; control: a read-then-write guard oversubscribes                            |
| `idempotency.spec.ts`          | **same key → original result**; different body → 409; parallel same key → one reservation; replayed 422; keys per subject; double release; **the same Kafka message is applied once** (real broker); failed handling commits no offset |
| `reconciliation.spec.ts`       | **an older snapshot does not roll the state back**; **a snapshot does not wipe local active reservations**; limit cut → negative availability; adjustment ordering; poison messages                                                    |
| `currency.spec.ts`             | **rate A → reserve, rate B → release: availability back to exactly the start**; stored rate and timestamp; JPY; rounding up; missing rate                                                                                              |
| `auth.spec.ts`                 | every operation in the spec × {no token, other key, expired, no `sub`, `alg=none`, garbage} → 401; docs paths in every spelling → 401                                                                                                  |
| `validation.spec.ts`           | each bad input → 400 and nothing written; ids, queries, 404s; DB down → 503 with no internal detail                                                                                                                                    |
| `availability.ledger.spec.ts`  | availability recomputed from ledger rows inserted directly; `asOf`; cache == ledger fold; DB refuses ledger mutation; pagination incl. same-millisecond ties                                                                           |
| `docs.contract.spec.ts`        | served spec == exported spec, version == package.json; Swagger assets load, nothing else under `/docs/`; error examples == error table; real responses validate                                                                        |
| `src/money/money.spec.ts`      | parsing and `bigint` conversion: exponents, rounding, 12-decimal rates, BIGINT range                                                                                                                                                   |

The concurrency test fires all 25 requests together through a 40-connection pool, so they genuinely overlap:
the control test proves the load interleaves by breaking a naive guard under it, and removing the guard's
condition in the code turns 5 tests red.

---

## Development

### Stack

|               |                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime**   | [Node.js 22](https://nodejs.org/docs/latest-v22.x/api/), [NestJS 12](https://docs.nestjs.com/) on Express 5, ES modules                                             |
| **Data**      | [PostgreSQL 17](https://www.postgresql.org/docs/17/) via [`pg`](https://node-postgres.com/), SQL migration files                                                    |
| **Messaging** | [Redpanda](https://docs.redpanda.com/) (Kafka API) via [kafkajs](https://kafka.js.org/)                                                                             |
| **API docs**  | [`@nestjs/swagger`](https://docs.nestjs.com/openapi/introduction), [Swagger UI](https://swagger.io/tools/swagger-ui/), [Redocly CLI](https://redocly.com/docs/cli/) |
| **Tooling**   | [pnpm](https://pnpm.io/), [Portless](https://github.com/vercel-labs/portless), [GitHub Actions](https://docs.github.com/actions)                                    |
| **Tests**     | [Vitest](https://vitest.dev/), [Testcontainers](https://node.testcontainers.org/), [Ajv](https://ajv.js.org/)                                                       |
| **Quality**   | TypeScript 6 strict, ESLint + typescript-eslint, Prettier                                                                                                           |

### Project structure

```
src/
├── main.ts                 migrate, optional seed, listen
├── create-app.ts           composition root (also used by tests and the spec export)
├── app.module.ts           providers: pool, FX, guard, filter, consumer
├── capacity/               the ledger, the concurrency guard, release, availability + asOf, treasury SQL
├── money/  fx/             bigint minor units, exact conversion; FxRateProvider + fixed table
├── http/                   controllers, DTOs (Swagger), hand-written validation, views
├── idempotency/            Idempotency-Key claim / replay
├── auth/                   global JWT guard, token verifier
├── errors/                 the error table, exception filter
├── docs/                   OpenAPI document, Swagger UI at /docs, error-table decorator, docs auth
├── treasury/               Kafka consumer, message parsing, exactly-once handler
├── logging/                one JSON line per request
└── db/                     pool + transactions, migration runner, seed
migrations/001_init.sql     schema, append-only trigger
scripts/                    mint-token, produce-treasury, export-openapi, ci-smoke.sh
test/                       the graded specs + helpers (Testcontainers, spec validator)
docs/api/openapi.json       exported spec (generated)
docs/decisions/             decision records
.claude/  tools/            Claude Code agents, skills and guard hooks used to build this (see CLAUDE.md)
```

### Environment

Compose sets everything itself. `pnpm start:dev` runs the service on the host: it copies `.env.example` to
`.env` if there is none, starts only Postgres and Redpanda from compose, builds, and runs it through
[Portless](https://github.com/vercel-labs/portless) at **`https://finverity.local`** (Swagger UI at
`https://finverity.local/docs`). Something stuck? Full reset:
`pnpm cache:clean && pnpm install && pnpm start:dev`.

<details>
<summary><b>About <code>finverity.local</code> (Portless)</b></summary>

<br>

Portless is a dev dependency that gives the host-run service a stable HTTPS name instead of a port number.
`docker compose up` does not use it: the reviewer path stays `http://localhost:3000`.

- Portless picks a free port (4000–4999) and passes it in as `PORT`. `portless list` shows which one.
- On first use it asks for `sudo`, to run its proxy on port 443 and trust its local certificate.
- `--lan` serves the name over mDNS, so it is reachable from other devices on the same Wi-Fi.
- If a crashed process still holds the name, add `--force` to the `portless run` call in `package.json`.
- To skip Portless for one run: `PORTLESS=0 pnpm start:dev`. The service is then at `http://localhost:3000`.
- Pinned to 0.13.0: later releases require Node 24, and this project runs on Node 22.

</details>

| Variable         | Default (local)                                         | Notes                                                    |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| `PORT`           | `3000`                                                  | under `start:dev` Portless sets it; set env wins `.env`  |
| `DATABASE_URL`   | `postgres://capacity:capacity@localhost:55432/capacity` | required                                                 |
| `DB_POOL_SIZE`   | `20`                                                    |                                                          |
| `JWT_SECRET`     | `dev-only-change-me-0123456789`                         | required, ≥ 16 characters; a dev value, never production |
| `JWT_ISSUER`     | empty                                                   | checked when set                                         |
| `JWT_AUDIENCE`   | empty                                                   | checked when set                                         |
| `KAFKA_ENABLED`  | `true`                                                  | `false` runs without the consumer                        |
| `KAFKA_BROKERS`  | `localhost:19092`                                       | comma separated; `redpanda:9092` inside compose          |
| `KAFKA_TOPIC`    | `treasury.capacity.v1`                                  |                                                          |
| `KAFKA_GROUP_ID` | `program-capacity`                                      |                                                          |
| `API_DOCS`       | `1` (compose); off when unset                           | serves `/docs` and `/openapi.json`, behind the JWT       |
| `SEED_DEMO_DATA` | `true` (compose)                                        | seeds the three demo programs (idempotent)               |
| `FX_RATES`       | empty = built-in table                                  | `USD/EUR=0.909091,EUR/USD=1.1,…`; validated at start-up  |

### Scripts

Run with `pnpm run <name>`. `pnpm run audit:submission` checks this table against `package.json`.

| Name                                                      | What it does                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `build`                                                   | compile `src/` and `scripts/` to `dist/`                                             |
| `cache:clean`                                             | remove `node_modules`, `dist` and test reports; run `pnpm install` afterwards        |
| `start` / `start:dev`                                     | run the built service / `.env`, Postgres + Redpanda, build, run via Portless         |
| `migrate`                                                 | apply migrations to `DATABASE_URL` (the service also does this on start)             |
| `token`                                                   | print a JWT (`-- --sub <name> --ttl <seconds>`)                                      |
| `produce`                                                 | send a treasury snapshot or adjustment to Kafka                                      |
| `typecheck` / `lint`                                      | `tsc --noEmit` / ESLint                                                              |
| `format` / `format:fix`                                   | Prettier check / write                                                               |
| `test` / `test:ci`                                        | unit tests / the same with a JUnit report                                            |
| `test:e2e` / `test:e2e:ci`                                | the graded specs (Docker) / the same with a JUnit report                             |
| `docs:export`                                             | write `docs/api/openapi.json` from the decorators (needs `build`)                    |
| `docs:check`                                              | build, export, and fail if the committed spec differs                                |
| `docs:lint`                                               | Redocly lint of the exported spec (rules in `redocly.yaml`)                          |
| `ci:quality`                                              | format, lint, types, unit, docs check, harness tests and audits                      |
| `test:tools`                                              | tests for the Claude Code guard rules in `tools/`                                    |
| `audit:harness` / `audit:invariants` / `audit:submission` | `.claude/` consistency / hard rules over `src/` and `migrations/` / the hand-in gate |

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request and push to `main`, one job
per check, in parallel, each one `pnpm` script you can run locally:

| Job                                 | Runs                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `Prettier` / `ESLint` / `Typecheck` | `format` / `lint` / `typecheck`                                                            |
| `Unit tests`                        | `test:ci` (JUnit artifact)                                                                 |
| `E2E (Postgres + Redpanda)`         | `test:e2e:ci` (JUnit artifact)                                                             |
| `Compose smoke test`                | `bash scripts/ci-smoke.sh`: compose up, token, every README call, `/docs`, a Kafka message |
| `OpenAPI spec`                      | `docs:check`, `docs:lint`                                                                  |
| `Harness and invariants`            | `test:tools`, `audit:harness`, `audit:submission`                                          |
| `CI passed`                         | fails if any job failed: **the one check to require** on `main`                            |

Actions are pinned to commit SHAs; Dependabot updates npm, actions and images weekly, grouped, after a 7-day
cooldown.

---

## Limitations and next steps

- **No UI.** API only, with Swagger UI for exploration.
- **No real FX service.** A fixed table. In production: a rate service with an agreed fixing policy, rates
  versioned and referenced from the reservation.
- **No multi-tenancy or roles.** Any valid token can act on any program; `sub` only scopes idempotency keys.
  In production: tenant claims checked against the program's funder, and roles for read vs reserve.
- **No ledger retention or archiving.** The ledger grows forever. In production: partition by month, snapshot
  folds for fast `asOf`, archive to cold storage.
- **No metrics exporter.** The log lines carry the dimensions (`route`, `status`, `outcome`, `durationMs`,
  treasury `outcome`); nothing collects them. In production: OpenTelemetry metrics and traces.
- **No Kubernetes**, and no deployment beyond docker compose.
- **No dead-letter topic.** Rejected messages are recorded in `processed_messages` and logged. A database
  error that is deterministic (not an outage) is retried forever and blocks its partition; a DLQ after N
  attempts is the next step.
- **No idempotency-key expiry.** Keys are kept forever; a TTL sweep (e.g. 30 days) is the next step.
- **No outbox.** Reservations are not published as events; an outbox table in the same transaction would be.
- **kafkajs** has had no release since 2023; a production service should evaluate Confluent's client.
- **Load not measured** beyond the 25-way concurrency tests. Under heavy contention on one program, the row
  lock serialises reservations by design.
- **Docs served by the app.** In production the spec would be published from CI and the docs not served from
  the API host.
- **Git hooks** (husky, commitlint) are not set up; CI enforces formatting, lint and types instead.
