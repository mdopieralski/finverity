---
name: ledger-model
description: >-
  The data model and the concurrency guard: append-only ledger_entries as the source of truth, programs as a
  materialised cache, reservations, the single atomic conditional UPDATE + ledger insert in one transaction,
  availability and ?asOf= derived from the ledger, migrations as files. Use when writing migrations, SQL,
  repositories, the reserve/release path, availability reads, or for "why conditional UPDATE?", "how is
  availability computed?", "can I add a column?".
---

# Ledger model and concurrency guard

Owner: the `ledger-engineer` agent. Decided in CLAUDE.md, not up for debate: **ledger, not a mutable
counter**. Ask the user before changing that.

## Tables (sketch: the migration is the truth)

```sql
programs (
  id                     TEXT PRIMARY KEY,
  currency               CHAR(3) NOT NULL,
  credit_limit_minor     BIGINT  NOT NULL CHECK (credit_limit_minor >= 0),   -- treasury-owned
  treasury_utilised_minor BIGINT NOT NULL DEFAULT 0,                          -- treasury-owned
  reserved_minor         BIGINT  NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0), -- local, cache of ACTIVE sum
  treasury_sequence      BIGINT  NOT NULL DEFAULT 0,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
)

reservations (
  id                    UUID PRIMARY KEY,
  program_id            TEXT NOT NULL REFERENCES programs,
  invoice_ref           TEXT NOT NULL,
  invoice_amount_minor  BIGINT NOT NULL CHECK (invoice_amount_minor > 0),
  invoice_currency      CHAR(3) NOT NULL,
  amount_minor          BIGINT NOT NULL CHECK (amount_minor > 0),   -- in program currency: what is released
  fx_rate               NUMERIC(24,12) NOT NULL,                     -- invoice → program; 1 when same currency
  fx_rate_at            TIMESTAMPTZ NOT NULL,
  fx_source             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('ACTIVE','RELEASED')),
  created_at, released_at
)  -- status is a projection of the ledger, kept for fast reads; the ledger decides.

ledger_entries (
  id               BIGSERIAL PRIMARY KEY,          -- total order for replay
  program_id       TEXT NOT NULL REFERENCES programs,
  kind             TEXT NOT NULL,                   -- RESERVE | RELEASE | TREASURY_ADJUSTMENT | TREASURY_REBASE | PROGRAM_OPENED
  component        TEXT NOT NULL,                   -- LOCAL | TREASURY_LIMIT | TREASURY_UTILISED
  delta_minor      BIGINT NOT NULL,                 -- signed; availability is a fold of deltas
  reservation_id   UUID NULL REFERENCES reservations,
  treasury_sequence BIGINT NULL,
  source           TEXT NOT NULL,                   -- 'http:<idempotency-key>' | 'kafka:<message-id>' | 'seed'
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
)
-- plus: a trigger that raises on UPDATE OR DELETE of ledger_entries (append-only in the DB, not just in code),
-- unique (reservation_id, kind) so one reservation is reserved once and released once.
```

Storing **deltas per component** is what makes `?asOf=` and the recompute test simple:

```
limit(t)     = Σ delta WHERE component = 'TREASURY_LIMIT'    AND recorded_at <= t
treasury(t)  = Σ delta WHERE component = 'TREASURY_UTILISED' AND recorded_at <= t
reserved(t)  = Σ delta WHERE component = 'LOCAL'             AND recorded_at <= t
available(t) = limit(t) − treasury(t) − reserved(t)
```

A snapshot that sets the limit from 10M to 8M writes `TREASURY_LIMIT −2,000,000.00`, never "limit = 8M".

## The concurrency guard (decided: conditional UPDATE)

```sql
BEGIN;
UPDATE programs
   SET reserved_minor = reserved_minor + $amount, updated_at = now()
 WHERE id = $programId
   AND credit_limit_minor - treasury_utilised_minor - reserved_minor >= $amount
RETURNING *;                         -- no row: insufficient capacity (or unknown program: check which)
INSERT INTO reservations …;
INSERT INTO ledger_entries (kind 'RESERVE', component 'LOCAL', delta +amount) …;
INSERT INTO idempotency_keys … (same tx: idempotency skill);
COMMIT;
```

**Why this and not `SELECT … FOR UPDATE`** (README "Behaviour decisions"): the check and the write are one
statement, so there is no read-then-decide window to get wrong in application code. Postgres takes the row
lock on UPDATE, and a concurrent UPDATE re-evaluates the WHERE against the committed row (READ COMMITTED
EvalPlanQual), so the second racer sees the first one's reservation. One round trip, no retry loop.
`FOR UPDATE` is equally correct but splits the decision across two statements and puts the invariant in
TypeScript. Optimistic locking with retries is over-engineering here (CLAUDE.md).

Rules:

- Lock order is always `programs` row first, then everything else, in every transaction that touches a program
  (reserve, release, adjustment, snapshot). No deadlocks by construction.
- Insufficient capacity is a **business outcome**: no row returned, roll back, respond with the error table's
  `insufficient_capacity`. Nothing is written, not even a ledger row (a test proves "one minor unit over the
  limit is rejected and writes nothing").
- Release:
  `UPDATE reservations SET status='RELEASED' … WHERE id=$1 AND status='ACTIVE' RETURNING amount_minor`, then
  `UPDATE programs SET reserved_minor = reserved_minor − amount` and a `RELEASE` ledger row with
  `delta −amount_minor`, all in one transaction. The amount comes from the reservation row, never recomputed.
- Transaction isolation: READ COMMITTED is enough for the guard. Say so and why.
- Pool: use a `pg` pool with a size that lets the concurrency test actually run statements in parallel.

## Availability reads

- Current: read the `programs` cache row (fast). `?asOf=<ISO-8601>`: fold the ledger up to that instant. A
  future `asOf` is a 400; one before the program existed is a 404 or zeroes (decide, document).
- The cache must equal the fold at all times. `test/availability.ledger.spec.ts` inserts ledger rows directly
  (no API) and asserts the recomputed availability; another test asserts cache == fold after a concurrent run.
- Return amounts as decimal strings of minor units plus the currency and exponent (money-and-fx skill).

## Migrations

- Real files in `migrations/`, numbered (`001_init.sql`, `002_idempotency.sql` …), run on start-up or by a
  `migrate` script before the service starts in compose. Never `synchronize: true` (the pre-edit hook denies
  it).
- A committed migration is immutable (the pre-edit hook denies edits): fix forward with a new file.
- Constraints carry invariants the DB can enforce: `CHECK (reserved_minor >= 0)`, `CHECK (amount_minor > 0)`,
  uniques for idempotency and for one RESERVE/one RELEASE per reservation, the append-only trigger.
- Money columns are `BIGINT`; FX rates `NUMERIC`. Float/real/double/money types are blocked by the post-edit
  hook.

## Driver

Default: `pg` (node-postgres) with parameterised SQL in repositories, because the guard is one hand-written
statement and an ORM would hide it. BIGINT comes back as a string from `pg` by default; parse it to `bigint`
in the repository, never to `number`. Read the installed `pg` version's docs before relying on type parsers.
