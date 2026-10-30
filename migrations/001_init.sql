-- Program capacity: schema v1.
-- The ledger (ledger_entries) is the source of truth. programs.* amounts are a cache of the ledger fold,
-- updated in the same transaction as every ledger insert. Money is BIGINT minor units; FX rates are NUMERIC.
-- Timestamps are kept at millisecond precision: that is what clients (JSON, JS Date) can express, so an
-- `asOf` or a page cursor built from a returned timestamp compares exactly.

CREATE TABLE programs (
  id                       TEXT PRIMARY KEY CHECK (id ~ '^prg_[a-z0-9_]{1,64}$'),
  name                     TEXT NOT NULL,
  currency                 CHAR(3) NOT NULL,
  -- Treasury-owned component: set by treasury adjustments and reconciliation snapshots.
  credit_limit_minor       BIGINT NOT NULL CHECK (credit_limit_minor >= 0),
  treasury_utilised_minor  BIGINT NOT NULL DEFAULT 0 CHECK (treasury_utilised_minor >= 0),
  -- Local component: sum of ACTIVE reservations made by this service.
  reserved_minor           BIGINT NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  treasury_sequence        BIGINT NOT NULL DEFAULT 0 CHECK (treasury_sequence >= 0),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE reservations (
  id                    UUID PRIMARY KEY,
  program_id            TEXT NOT NULL REFERENCES programs (id),
  invoice_ref           TEXT NOT NULL,
  invoice_amount_minor  BIGINT NOT NULL CHECK (invoice_amount_minor > 0),
  invoice_currency      CHAR(3) NOT NULL,
  -- In the program currency: exactly what the reservation took and what its release gives back.
  amount_minor          BIGINT NOT NULL CHECK (amount_minor > 0),
  fx_rate               NUMERIC(30, 12) NOT NULL CHECK (fx_rate > 0),
  fx_rate_at            TIMESTAMPTZ NOT NULL,
  fx_source             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  released_at           TIMESTAMPTZ,
  CHECK ((status = 'RELEASED') = (released_at IS NOT NULL))
);
CREATE INDEX reservations_program_page ON reservations (program_id, created_at DESC, id DESC);

CREATE TABLE ledger_entries (
  id                 BIGSERIAL PRIMARY KEY,
  program_id         TEXT NOT NULL REFERENCES programs (id),
  kind               TEXT NOT NULL CHECK (kind IN ('PROGRAM_OPENED', 'RESERVE', 'RELEASE', 'TREASURY_ADJUSTMENT', 'TREASURY_REBASE')),
  component          TEXT NOT NULL CHECK (component IN ('LOCAL', 'TREASURY_LIMIT', 'TREASURY_UTILISED')),
  delta_minor        BIGINT NOT NULL,
  reservation_id     UUID REFERENCES reservations (id),
  treasury_sequence  BIGINT,
  source             TEXT NOT NULL,
  -- Transaction time: every row one transaction writes (e.g. a snapshot's two rebase rows) shares it.
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', now()),
  CHECK ((kind IN ('RESERVE', 'RELEASE')) = (reservation_id IS NOT NULL))
);
CREATE INDEX ledger_entries_program_time ON ledger_entries (program_id, recorded_at, id);
-- One reserve and at most one release per reservation, whatever the code does.
CREATE UNIQUE INDEX ledger_entries_one_per_reservation ON ledger_entries (reservation_id, kind)
  WHERE reservation_id IS NOT NULL;

-- Append-only, enforced by the database and not only by the code.
CREATE FUNCTION ledger_entries_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END;
$$;
CREATE TRIGGER ledger_entries_no_mutation
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only();

-- HTTP idempotency: one row per (client, key), written in the same transaction as the reservation.
CREATE TABLE idempotency_keys (
  subject          TEXT NOT NULL,
  key              TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_status  INT,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (subject, key)
);

-- Kafka dedup: one row per treasury message id, written in the same transaction as its effect.
CREATE TABLE processed_messages (
  message_id    TEXT PRIMARY KEY,
  topic         TEXT NOT NULL,
  partition     INT NOT NULL,
  "offset"      BIGINT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('applied', 'stale', 'rejected', 'overcommitted')),
  detail        TEXT,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
