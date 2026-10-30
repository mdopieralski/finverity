# Program Capacity & Invoice Reservation

Backend take-home. This file is the brief and the source of truth for this repo (rules, decisions, team).

---

## The task, verbatim

> A financing program has a total credit limit (e.g. $10,000,000). When an invoice is approved for early
> payment, it reserves a portion of that capacity. When repaid, the amount is released back. Your task is to
> implement a module that tracks this in real time — accepting reservations, processing releases, and exposing
> current availability to clients.
>
> Capacity data also flows in from an external treasury system via Kafka, including periodic bulk
> reconciliation messages that bring a program's full state up to date. Programs and invoices may be
> denominated in different currencies.
>
> All endpoints must be authenticated. The service should be runnable locally. Treat this as production code —
> if you make assumptions or trade-offs, document them briefly.

The domain is supply chain finance: a funder gives a buyer's supply chain a credit line, suppliers get their
invoices paid early against it, and repayment frees the line again. Get the domain words right (`scf-domain`
skill).

---

## What is actually being graded

Four things. Everything else is hygiene.

1. **No oversubscription under concurrency.** Two reservations racing on one program must never exceed the
   limit. In this domain that is money paid out without cover.
2. **Idempotency.** Kafka is at-least-once. The same message will arrive twice. So will a retried HTTP call.
3. **Reconciliation ordering.** A full snapshot that is older than what has already been applied must not roll
   the state back — and must not wipe reservations this service made itself.
4. **Currency invariant.** Convert once, at reservation time; release exactly what was taken.

Build these correctly, document them in the README, and the submission is strong even with a modest feature
surface. Miss one and a polished CRUD app does not save it.

---

## Decisions already made — do not relitigate

### Ledger, not a mutable counter

Reservations and releases are **immutable rows appended to a ledger**. Available capacity is **derived**, not
stored as a column that gets overwritten.

Why: the customers here are banks and NBFIs. An auditor must be able to reconstruct availability at any past
moment. A rubbed-out number cannot answer that; a ledger can.

A materialised cache of the current figure is allowed, but **the ledger stays the source of truth**, and a
test must prove availability can be recomputed from it alone. (`ledger-model` skill)

### Money

Integer minor units everywhere. Never floats, never `number` for amounts that cross a boundary. Reject
fractional amounts at the edge with 400. Handle currencies with a zero exponent (JPY) or state the
simplification in the README. (`money-and-fx` skill)

### Concurrency guard

A single atomic conditional update, with the ledger insert **in the same transaction**:

```sql
UPDATE programs
   SET reserved = reserved + $amount
 WHERE id = $programId
   AND reserved + $amount <= credit_limit
RETURNING *;
```

No returned row means "insufficient capacity" — a business outcome, not an error. `SELECT … FOR UPDATE` is an
acceptable alternative; pick one, and **write down why** in the README. Optimistic locking with retries is
over-engineering here.

### Idempotency

- HTTP: an `Idempotency-Key` header on `POST /reservations`, stored under a unique constraint. A replay with
  the **same** body returns the original result. A replay with a **different** body is `409`.
- Kafka: dedupe on the message id in a `processed_messages` table, written **in the same transaction** as the
  business effect. Commit the offset **after** that transaction, never before.

Write in the README: _the broker guarantees at-least-once, so exactly-once is achieved by consumer-side dedup,
not by the broker._ (`idempotency` skill)

### Reconciliation

Every program carries `treasury_sequence`. A snapshot is applied **only if its sequence is strictly greater**.
Equal or lower is discarded and logged.

And the half that is easy to miss: a snapshot **rebases only the treasury-owned component** of capacity.
Reservations this service holds as `ACTIVE` are re-applied on top of the new baseline. A snapshot must never
silently delete local reservations. (`treasury-kafka` skill)

### Currency

Convert at reservation time. Store the converted amount **plus the rate plus the timestamp**. On release,
return exactly the stored amount — never reconvert.

Rate source: an injected `FxRateProvider` with a fixed table for local running. In the README: _production
would use a rate service with a defined fixing policy; fixing policy is a business decision, not an
engineering one._

### Errors

One table mapping failure kind → HTTP status → **fixed client message** → log outcome. Client messages are
constant strings so upstream or database detail never leaks. Each request logs one structured line with a
one-word `outcome`. (`nestjs-service` skill)

### Auth

JWT bearer on **every** endpoint, availability reads included. Signing key from the environment. Ship a small
script or dev endpoint that mints a token so a reviewer can actually use the API. **Chosen: a script**
(`pnpm run token`), so no route is ever unauthenticated.

### API docs (decided by the user, 2026-10-28)

Swagger UI at `/docs`, the OpenAPI document at `/openapi.json`, **both behind the same JWT**: the browser page
uses HTTP Basic with the token as the password, the JSON takes `Authorization: Bearer`. The spec is
**generated from `@nestjs/swagger` decorators**, versioned from `package.json`, exported to
`docs/api/openapi.json` (generated, never hand-edited), linted with Redocly, and contract-tested so docs
cannot drift from code. Pattern taken from the ingrid repo, adapted. (`api-docs` skill)

---

## Stack

- **Node 22, TypeScript strict, NestJS, PostgreSQL, Kafka.** pnpm 10 (pinned in `packageManager`).
- **As built (2026-10-28):** NestJS 12 (ESM-only, so `"type": "module"`), TypeScript 6.0, Vitest 4 (Nest 12's
  ESM default), `pg` + SQL migrations, kafkajs 2.2.4, Redpanda v26.1, Postgres 18 (from 17, 2026-10-30).
  Rationale: `docs/decisions/stack-2026-10-28.md`.
- NestJS because the role lists it as a must-have; this is the place to show it. If it starts costing more
  than half a day of framework friction, fall back to Fastify and say so in the README.
- **Redpanda instead of full Kafka in `docker compose`** — Kafka-protocol compatible, one service instead of
  Kafka plus ZooKeeper, starts in seconds. This is a deliberate trade-off and belongs in the README.
- Migrations as real files, not `synchronize: true`.
- Tests: the framework's default runner plus Testcontainers or a compose-backed test database. Concurrency
  tests must hit real HTTP against a real database — an in-memory fake proves nothing about row locking.

**Library versions change. Do not trust training data.** Read the installed version in `package.json` and
`node_modules`, then that version's documentation — NestJS, the Kafka client and the Postgres driver all have
breaking changes between majors.

### Choices made (recorded in `docs/decisions/stack-2026-10-28.md`)

| Choice             | Decided                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| Postgres access    | `pg` + hand-written SQL, plain `.sql` migrations + a small runner       |
| Kafka client       | `kafkajs`, used directly, `autoCommit: false`                           |
| Request validation | hand-written edge validators (no class-validator: outside the dep list) |
| JSON logging       | own one-line writer + Nest `ConsoleLogger({ json: true })`              |
| Concurrency guard  | conditional UPDATE                                                      |
| Spec source        | `@nestjs/swagger` decorators (user, 2026-10-28)                         |
| Git hooks          | **open:** husky + commitlint + lint-staged need the user's OK           |

---

## API

| Method | Path                         | Purpose                                      |
| ------ | ---------------------------- | -------------------------------------------- |
| POST   | `/programs/:id/reservations` | reserve capacity; `Idempotency-Key` required |
| POST   | `/reservations/:id/release`  | release it back                              |
| GET    | `/programs/:id/availability` | current availability; optional `?asOf=`      |
| GET    | `/programs/:id/reservations` | list, paginated                              |

Plus a Kafka consumer for treasury adjustments and reconciliation snapshots.

---

## Tests — the submission's actual argument

Name the files so the directory listing explains the design. A reviewer reads names before code.

```
capacity.concurrency.spec.ts
idempotency.spec.ts
reconciliation.spec.ts
currency.spec.ts
auth.spec.ts
validation.spec.ts
availability.ledger.spec.ts
```

**The five that must exist:**

1. `N concurrent reservations against a limit that fits N-1 → exactly one is rejected and the sum never exceeds the limit`
   — real parallel HTTP, real database
2. `the same Idempotency-Key returns the original result` and `the same Kafka message is applied once`
3. `an older snapshot does not roll the state back`
4. `a snapshot does not wipe local active reservations`
5. `reserving at rate A and releasing after the rate moves to B returns availability to exactly its starting value`

Worth adding if time allows: a replay with the same key but a different body returns 409; an amount one minor
unit over the limit is rejected **and writes nothing**; availability recomputed from ledger rows inserted
directly; no endpoint answers without a token; error messages never leak internal detail. (`testing-strategy`
skill; `pnpm run audit:submission` checks files and titles.)

---

## Local run

`docker compose up` brings up Postgres, Redpanda and the service. Then the `curl` examples in the README work,
against seeded programs in at least two currencies.

One command. A reviewer who cannot start it stops reading — treat this as a graded requirement, because it
effectively is. (`local-run` skill)

---

## README

Sections, in this order:

**Quick start** → **API** → **How it works** (one diagram) → **Behaviour decisions** → **Assumptions and
trade-offs** → **Limitations and next steps**

The task says _"if you make assumptions or trade-offs, document them briefly"_, so those two sections are
graded, not decoration. Write them **as you go**, not at the end. Layout modelled on the ingrid README (proof
curl up top, Testing / Development / CI tables between the trade-offs and the limitations, tables kept in sync
with `package.json` and `.env.example` by `audit:submission`). (`submission-readme` skill)

---

## Out of scope — say so in the README

No UI. No real FX service. No multi-tenancy or roles beyond JWT validation. No ledger retention or archiving.
No metrics exporter, though the log lines carry the dimensions one would need. No Kubernetes.

**A documented omission is a senior signal. A silent one is a gap.**

---

## Working order

Domain model and ledger → concurrency guard **with its test** → API with auth → idempotency → Kafka consumer →
reconciliation → currency → README polish.

Stop and ask before: changing the ledger decision, adding a dependency that is not Nest, Postgres, Kafka
client, or test tooling, or expanding the API beyond the four endpoints above.

---

## Harness: hard rules the hooks enforce

- **Ledger append-only:** UPDATE/DELETE/TRUNCATE on `ledger_entries` in `src/` or `migrations/` is denied.
- **Money:** new `amount…: number`, `parseFloat`, `toFixed`, `Math.round/floor/ceil` in `src/`, and float /
  real / double / money column types in migrations are blocked.
- **Schema:** `synchronize: true` denied; editing a committed migration denied (fix forward).
- **Auth everywhere:** public-route decorators (`@Public()` and friends) denied.
- **Secrets and generated files:** `.env*` (except `.env.example`), `pnpm-lock.yaml`, `dist/` never edited.
- pnpm only (`pnpm add`, `pnpm exec`, `pnpm dlx`). Never npm, npx or yarn. Never push to `main`, never
  force-push, never skip git hooks. `gh pr merge`, a public repo and `docker compose down -v` ask first.

## Layout (target; filled in by the working order)

```
src/
  capacity/   money/   fx/   db/        ledger-engineer: ledger, guard, availability, FX, pool, migrate, seed
  http/  auth/  errors/  logging/  idempotency/  config/  docs/  main.ts  app.module.ts   api-engineer
  treasury/                             messaging-engineer: consumer, schemas, dedup, offsets
migrations/                             NNN_<name>.sql, immutable once committed
scripts/mint-token.ts                   `pnpm run token`
scripts/produce-treasury.ts             `pnpm run produce -- snapshot <program> --seq N …`
scripts/export-openapi.ts               `pnpm run docs:export` → docs/api/openapi.json (generated)
scripts/ci-smoke.sh                     compose up + token + curls + /docs, same locally and in CI
test/                                   the seven graded specs + docs.contract + helpers (Testcontainers)
.github/                                CI (one job per check, `CI passed`), setup action, Dependabot
docs/decisions/                         <topic>-YYYY-MM-DD.md
Dockerfile  docker-compose.yml  .env.example
tools/                                  harness rules, harness + invariants audits (node --test)
.claude/                                agents, skills, hooks
```

## Team: agents and who owns what

The ownership map with paths is in the `add-feature` skill (§2). In short:

| Agent                | Owns                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `capacity-architect` | plans each working-order step (read-only)                                                              |
| `ledger-engineer`    | migrations, ledger, concurrency guard, reserve/release, availability + asOf, money, FX                 |
| `api-engineer`       | Nest HTTP: endpoints, JWT guard + token script, Idempotency-Key, error table, logging, Swagger/OpenAPI |
| `messaging-engineer` | Kafka/Redpanda consumer, processed_messages, sequence ordering, snapshot handling                      |
| `platform-engineer`  | scaffold, package.json, Dockerfile, docker-compose, env, cold start                                    |
| `test-engineer`      | `test/`: the seven graded specs, real parallel HTTP + real DB, proving tests can fail                  |
| `docs-engineer`      | `README.md`, `docs/`: sections in order, decisions and trade-offs as we go                             |
| `code-reviewer`      | reviews diffs against the four invariants first (read-only)                                            |
| `harness-engineer`   | `.claude/`, `tools/`, CI + Dependabot (`.github/`), root configs, this file                            |

Workflow skills: `add-feature` (plan → spec + build in parallel → verify → review → README), `verify-change`
(which checks prove what), `ship-branch` (commit, PR), `submission-check` (final go/no-go), `release-delivery`
(version, tag, release notes, hand-off), `ci-pipeline` (GitHub Actions). First time: `scaffold-service`.

## Commands

```bash
docker compose up --build        # Postgres + Redpanda + service, migrations + seeds (local-run skill)
pnpm start:dev                   # on the host via Portless → https://finverity.local (PORTLESS=0 → localhost:3000)
pnpm cache:clean && pnpm install # full reset (node_modules, dist, test reports)
pnpm run token                   # mint a JWT for curl, and the password for /docs
open http://localhost:3000/docs  # Swagger UI (any username, password = the token)
pnpm run docs:export             # regenerate docs/api/openapi.json; docs:check / docs:lint in CI
pnpm run produce -- snapshot prg_eur_acme --seq 2 --limit 900000000 --utilised 0
pnpm test                        # unit
pnpm run test:e2e                # the seven graded specs (needs Docker)
pnpm run ci:quality              # format, lint, typecheck, unit, tool tests, audits
pnpm run test:tools              # harness rule tests
pnpm run audit:harness           # .claude/ consistency
pnpm run audit:invariants        # hard rules over src/ and migrations/
pnpm run audit:submission        # the submission gate: specs, must-have titles, README, compose
```

## Git

Branches `feat/<area>`, `fix/<area>`, `docs/…`, `chore/…` from `main`, PR into `main`; the user merges.
Conventional Commits, scope = area (`ledger`, `capacity`, `fx`, `api`, `auth`, `idempotency`, `treasury`,
`platform`, `test`, `docs`, `claude`, `tooling`). History should read in the working order.
