---
name: testing-strategy
description: >-
  How this service is tested and why the tests are the submission's argument: the seven spec files and their
  names, the five must-have tests, real parallel HTTP against a real Postgres (Testcontainers or the compose
  database), making concurrency tests actually concurrent, per-test isolation, Kafka tests, and what never to
  fake. Use when writing or reviewing anything in test/, or for "how do I test the race?", "is this test
  meaningful?", "which spec does this go in?".
---

# Testing strategy

Owner of `test/`: the `test-engineer` agent. Implementing agents write colocated unit tests
(`src/**/*.spec.ts`) for pure logic (money conversion, error mapping, cursor encoding).

## The directory listing is the argument

```
test/
  capacity.concurrency.spec.ts   no oversubscription under real parallel HTTP
  idempotency.spec.ts            HTTP key replay / 409 / parallel same key; Kafka message applied once
  reconciliation.spec.ts         sequence ordering; snapshots keep local reservations; limit cuts
  currency.spec.ts               convert once; release exact after the rate moves; JPY
  auth.spec.ts                   no endpoint answers without a valid token
  validation.spec.ts             400s for bad input; no internal detail ever leaks
  availability.ledger.spec.ts    availability recomputed from ledger rows alone; asOf; cache == fold
  docs.contract.spec.ts          the served OpenAPI matches the app: schemas, statuses, messages, version (api-docs skill)
  helpers/                       app bootstrap, db reset, token, parallel(), kafka produce, expectMatchesSpec()
```

`pnpm run audit:submission` checks these files and the five must-have titles exist. Keep the titles exactly:

1. `N concurrent reservations against a limit that fits N-1 → exactly one is rejected and the sum never exceeds the limit`
2. `the same Idempotency-Key returns the original result` · `the same Kafka message is applied once`
3. `an older snapshot does not roll the state back`
4. `a snapshot does not wipe local active reservations`
5. `reserving at rate A and releasing after the rate moves to B returns availability to exactly its starting value`

Worth adding (CLAUDE.md): same key + different body → 409; one minor unit over the limit is rejected **and
writes nothing** (count ledger and reservation rows before/after); availability recomputed from ledger rows
inserted directly; every endpoint × {no token, bad signature, expired} → 401; error bodies never contain SQL,
stack or internals.

## Docs contract and auth coverage (ingrid group F)

- `expectMatchesSpec(res, method, path)` validates status and body against the generated OpenAPI document
  (Ajv); every spec file calls it on the responses it already gets, so all suites double as contract tests.
- `auth.spec.ts` iterates **the spec's own operations** (no hand-kept list) × {no token, forged, expired} →
  401, plus `/docs`, a `/docs` asset and `/openapi.json` without credentials → 401. A new endpoint is covered
  on arrival.
- Reporting: `test:ci` / `test:e2e:ci` add Vitest's built-in JUnit reporter for the CI artifact.

## Real, not faked

- **Real Postgres, real HTTP.** The app boots in-process (`Test.createTestingModule` → `app.listen(0)`) and
  tests hit it over a real socket with real concurrent requests (`fetch`/`undici` or supertest against the
  listening URL, not the in-memory handler). An in-memory repository proves nothing about row locking.
- **Database:** Testcontainers (`@testcontainers/postgresql`, `@testcontainers/redpanda` or a generic Redpanda
  container) started in Vitest `globalSetup` (`test/global-setup.ts`); each suite gets its own database with
  migrations applied (`test/helpers/app.ts`). Fallback: `TEST_DATABASE_URL` pointing at the compose Postgres.
  Pick one, document it.
- **Isolation:** each test creates its own program(s) with unique ids, so tests can run in any order. Reset
  with TRUNCATE in `test/helpers/db.ts` only between files when needed (the ledger append-only rule allows
  this only in test helpers).

## Making the concurrency test mean something

- N ≥ 20 requests, limit = (N−1) × amount. Fire them **all at once**: build the requests first, then
  `Promise.all` them, ideally behind a start barrier. Use a fresh `Idempotency-Key` per request.
- The pg pool must be ≥ N (or at least large enough that statements genuinely overlap). Log the pool size in
  the test name or a comment; a pool of 1 serialises everything and the test passes for the wrong reason.
- Assert all of: exactly N−1 × 201, exactly 1 × 422; `reserved_minor` = (N−1) × amount; Σ ledger LOCAL deltas
  = `reserved_minor` ≤ limit; reservation rows = N−1.
- **Prove the test can fail:** temporarily run the reserve path without the `AND … <= limit` condition (or
  with a read-then-write variant behind a test-only flag) and see the test go red. Record that you did, in the
  PR body. Don't leave the flag in production code if it can be avoided; a separate deliberately-broken
  repository in `test/helpers/` is cleaner.
- Repeat the run a few times in one test (e.g. 5 rounds) to catch flakiness.

## Kafka tests

- Precise cases (stale, equal, duplicate) may call the consumer's message handler directly with a real DB
  transaction: fast and deterministic.
- At least one test goes through Redpanda: produce the same message twice, wait until processed (poll the DB
  for the `processed_messages` row with a timeout, never `sleep`), assert one effect and the committed offset.

## Runner

Vitest 4: Nest 12 is ESM-only and its ESM template uses Vitest, so that is the framework default here
(`docs/decisions/stack-2026-10-28.md`). `pnpm test` = unit (`src/**/*.spec.ts`), `pnpm run test:e2e` =
everything in `test/` (needs Docker), files one at a time (`fileParallelism: false`), `LOG_SILENT=1`. Filter
by file name: `pnpm run test:e2e capacity.concurrency`. Explicit `@Inject()` tokens everywhere, so nothing
depends on the test transformer emitting decorator metadata.
