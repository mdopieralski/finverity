-- Fixes from the code review of schema v1 (001 is committed, so it is fixed forward here).

-- 1. Ledger time is the moment the row is written, not the moment its transaction began.
--    With now(), a transaction that waited on the program row lock stamped its rows with its START time
--    and committed later, so an `asOf` answer already given could change. Every ledger row is written
--    while its writer holds the program row lock; reads at `asOf` take FOR SHARE on that row first
--    (src/capacity/capacity.repository.ts), so an answer, once given, stays the same. Reserve and release
--    rows carry their reservation's created_at / released_at (also stamped under that lock); the rows of
--    one treasury change share one stamp. Those inserts pass it explicitly; this default covers the rest.
ALTER TABLE ledger_entries
  ALTER COLUMN recorded_at SET DEFAULT date_trunc('milliseconds', clock_timestamp());

-- 2. Append-only covers TRUNCATE too. The row-level trigger in 001 does not fire on it.
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_append_only();

-- 3. One ACTIVE reservation per invoice and program: the same receivable is never financed twice.
--    The service checks it under the program row lock and answers 409; this index is the backstop.
CREATE UNIQUE INDEX reservations_one_active_per_invoice
  ON reservations (program_id, invoice_ref)
  WHERE status = 'ACTIVE';
