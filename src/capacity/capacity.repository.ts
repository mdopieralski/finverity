// All SQL that changes capacity. Every change appends to ledger_entries (the source of truth) and
// updates the programs cache in the same transaction.
//
// Locking, and why there are no deadlocks:
//   reserve   → programs row (conditional UPDATE), then inserts only
//   release   → reservations row (conditional UPDATE), then programs row
//   treasury  → programs row (SELECT … FOR UPDATE), then inserts only
// No path takes a reservations row lock after a programs row lock, so no cycle exists.
import { randomUUID } from 'node:crypto';

import type { Db, Tx } from '../db/database.js';
import { type CurrencyCode } from '../money/currencies.js';
import type {
  Availability,
  ReleaseResult,
  Reservation,
  ReservationStatus,
  TreasuryAdjustment,
  TreasuryOutcome,
  TreasurySnapshot,
} from './capacity.types.js';

interface ReservationRow {
  id: string;
  program_id: string;
  invoice_ref: string;
  invoice_amount_minor: string;
  invoice_currency: string;
  amount_minor: string;
  currency: string;
  fx_rate: string;
  fx_rate_at: Date;
  fx_source: string;
  status: ReservationStatus;
  created_at: Date;
  released_at: Date | null;
}

interface ProgramRow {
  id: string;
  currency: string;
  credit_limit_minor: string;
  treasury_utilised_minor: string;
  reserved_minor: string;
  treasury_sequence: string;
}

/** NUMERIC comes back as "0.909091000000": drop the padding, keep it exact. */
const normaliseRate = (r: string): string => (r.includes('.') ? r.replace(/0+$/, '').replace(/\.$/, '') : r);

const RESERVATION_COLUMNS = `r.id, r.program_id, r.invoice_ref, r.invoice_amount_minor, r.invoice_currency,
  r.amount_minor, p.currency, r.fx_rate, r.fx_rate_at, r.fx_source, r.status, r.created_at, r.released_at`;

export function toReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    programId: row.program_id,
    invoiceRef: row.invoice_ref,
    invoiceAmountMinor: BigInt(row.invoice_amount_minor),
    invoiceCurrency: row.invoice_currency as CurrencyCode,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency as CurrencyCode,
    fxRate: normaliseRate(row.fx_rate),
    fxRateAt: row.fx_rate_at,
    fxSource: row.fx_source,
    status: row.status,
    createdAt: row.created_at,
    releasedAt: row.released_at,
  };
}

const toAvailability = (row: ProgramRow, asOf: Date | null): Availability => {
  const creditLimitMinor = BigInt(row.credit_limit_minor);
  const treasuryUtilisedMinor = BigInt(row.treasury_utilised_minor);
  const reservedMinor = BigInt(row.reserved_minor);
  return {
    programId: row.id,
    currency: row.currency as CurrencyCode,
    creditLimitMinor,
    treasuryUtilisedMinor,
    reservedMinor,
    availableMinor: creditLimitMinor - treasuryUtilisedMinor - reservedMinor,
    treasurySequence: BigInt(row.treasury_sequence),
    asOf,
  };
};

export async function findProgramCurrency(db: Db | Tx, programId: string): Promise<CurrencyCode | null> {
  const { rows } = await db.query<{ currency: string }>('SELECT currency FROM programs WHERE id = $1', [
    programId,
  ]);
  return (rows[0]?.currency as CurrencyCode | undefined) ?? null;
}

export interface NewReservation {
  programId: string;
  invoiceRef: string;
  invoiceAmountMinor: bigint;
  invoiceCurrency: CurrencyCode;
  amountMinor: bigint;
  fxRate: string;
  fxRateAt: Date;
  fxSource: string;
  source: string;
}

/**
 * The concurrency guard. The capacity check and the write are ONE statement: Postgres locks the row
 * on UPDATE, and a concurrent UPDATE waiting on that lock re-evaluates the WHERE clause against the
 * committed row (READ COMMITTED), so the second of two racers sees the first one's reservation.
 * No row back = insufficient capacity; nothing has been written. The reservation and its ledger row
 * are inserted in the same transaction.
 */
export async function reserveCapacity(tx: Tx, r: NewReservation): Promise<Reservation | null> {
  const guarded = await tx.query(
    `UPDATE programs
        SET reserved_minor = reserved_minor + $2, updated_at = clock_timestamp()
      WHERE id = $1
        AND credit_limit_minor - treasury_utilised_minor - reserved_minor >= $2
      RETURNING id`,
    [r.programId, r.amountMinor.toString()]
  );
  if (guarded.rowCount === 0) {
    return null;
  }
  const id = randomUUID();
  await tx.query(
    `INSERT INTO reservations (id, program_id, invoice_ref, invoice_amount_minor, invoice_currency,
                               amount_minor, fx_rate, fx_rate_at, fx_source, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE')`,
    [
      id,
      r.programId,
      r.invoiceRef,
      r.invoiceAmountMinor.toString(),
      r.invoiceCurrency,
      r.amountMinor.toString(),
      r.fxRate,
      r.fxRateAt,
      r.fxSource,
    ]
  );
  await tx.query(
    `INSERT INTO ledger_entries (program_id, kind, component, delta_minor, reservation_id, source)
     VALUES ($1, 'RESERVE', 'LOCAL', $2, $3, $4)`,
    [r.programId, r.amountMinor.toString(), id, r.source]
  );
  return (await findReservation(tx, id)) as Reservation;
}

/**
 * Release returns exactly the stored amount_minor: never reconverted. `… AND status = 'ACTIVE'`
 * matches once; a second release finds RELEASED and returns the original release unchanged.
 */
export async function releaseCapacity(tx: Tx, reservationId: string, source: string): Promise<ReleaseResult> {
  const released = await tx.query<{ program_id: string; amount_minor: string }>(
    `UPDATE reservations SET status = 'RELEASED', released_at = date_trunc('milliseconds', clock_timestamp())
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING program_id, amount_minor`,
    [reservationId]
  );
  const row = released.rows[0];
  if (!row) {
    const existing = await findReservation(tx, reservationId);
    return existing
      ? { ok: true, reservation: existing, alreadyReleased: true }
      : { ok: false, kind: 'reservation_not_found' };
  }
  await tx.query(
    `UPDATE programs SET reserved_minor = reserved_minor - $2, updated_at = clock_timestamp() WHERE id = $1`,
    [row.program_id, row.amount_minor]
  );
  await tx.query(
    `INSERT INTO ledger_entries (program_id, kind, component, delta_minor, reservation_id, source)
     VALUES ($1, 'RELEASE', 'LOCAL', $2, $3, $4)`,
    [row.program_id, (-BigInt(row.amount_minor)).toString(), reservationId, source]
  );
  return {
    ok: true,
    reservation: (await findReservation(tx, reservationId)) as Reservation,
    alreadyReleased: false,
  };
}

export async function findReservation(db: Db | Tx, id: string): Promise<Reservation | null> {
  const { rows } = await db.query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS} FROM reservations r JOIN programs p ON p.id = r.program_id WHERE r.id = $1`,
    [id]
  );
  return rows[0] ? toReservation(rows[0]) : null;
}

export interface PageQuery {
  status?: ReservationStatus;
  limit: number;
  after?: { createdAt: Date; id: string };
}

/** Newest first; keyset pagination on (created_at, id) so pages stay stable while rows are added. */
export async function listReservations(db: Db, programId: string, q: PageQuery): Promise<Reservation[]> {
  const params: unknown[] = [programId, q.limit];
  let where = 'r.program_id = $1';
  if (q.status) {
    params.push(q.status);
    where += ` AND r.status = $${params.length}`;
  }
  if (q.after) {
    params.push(q.after.createdAt, q.after.id);
    where += ` AND (r.created_at, r.id) < ($${params.length - 1}, $${params.length})`;
  }
  const { rows } = await db.query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS} FROM reservations r JOIN programs p ON p.id = r.program_id
      WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT $2`,
    params
  );
  return rows.map(toReservation);
}

/** Current availability from the programs cache. */
export async function currentAvailability(db: Db, programId: string): Promise<Availability | null> {
  const { rows } = await db.query<ProgramRow>(
    `SELECT id, currency, credit_limit_minor, treasury_utilised_minor, reserved_minor, treasury_sequence
       FROM programs WHERE id = $1`,
    [programId]
  );
  return rows[0] ? toAvailability(rows[0], null) : null;
}

/**
 * Availability folded from the ledger alone, up to `asOf` (inclusive). This is what an auditor would
 * compute; the cache must always equal it (test/availability.ledger.spec.ts).
 */
export async function ledgerAvailability(
  db: Db,
  programId: string,
  asOf: Date
): Promise<Availability | null> {
  const { rows } = await db.query<ProgramRow>(
    `SELECT p.id, p.currency,
            COALESCE(SUM(l.delta_minor) FILTER (WHERE l.component = 'TREASURY_LIMIT'), 0)    AS credit_limit_minor,
            COALESCE(SUM(l.delta_minor) FILTER (WHERE l.component = 'TREASURY_UTILISED'), 0) AS treasury_utilised_minor,
            COALESCE(SUM(l.delta_minor) FILTER (WHERE l.component = 'LOCAL'), 0)             AS reserved_minor,
            COALESCE(MAX(l.treasury_sequence), 0)                                           AS treasury_sequence
       FROM programs p
       LEFT JOIN ledger_entries l ON l.program_id = p.id AND l.recorded_at <= $2
      WHERE p.id = $1
      GROUP BY p.id, p.currency`,
    [programId, asOf]
  );
  return rows[0] ? toAvailability(rows[0], asOf) : null;
}

// ---------- Treasury (called by the Kafka consumer inside its transaction) ----------

async function lockProgram(tx: Tx, programId: string): Promise<ProgramRow | null> {
  const { rows } = await tx.query<ProgramRow>(
    `SELECT id, currency, credit_limit_minor, treasury_utilised_minor, reserved_minor, treasury_sequence
       FROM programs WHERE id = $1 FOR UPDATE`,
    [programId]
  );
  return rows[0] ?? null;
}

const overcommitted = (limit: bigint, treasury: bigint, reserved: bigint): boolean =>
  limit - treasury - reserved < 0n;

/**
 * A reconciliation snapshot. Applied only if its sequence is STRICTLY greater than the program's
 * (equal or lower = stale, discarded). It rebases only the treasury-owned component (limit and treasury
 * utilisation) as ledger deltas; reserved_minor and ACTIVE reservations are untouched and stay on top.
 */
export async function applyTreasurySnapshot(
  tx: Tx,
  s: TreasurySnapshot,
  source: string
): Promise<TreasuryOutcome> {
  const p = await lockProgram(tx, s.programId);
  if (!p) {
    return { outcome: 'rejected', detail: 'unknown program' };
  }
  if (p.currency !== s.currency) {
    return {
      outcome: 'rejected',
      detail: `currency ${s.currency} is not the program currency ${p.currency}`,
    };
  }
  const current = BigInt(p.treasury_sequence);
  if (s.sequence <= current) {
    return { outcome: 'stale', detail: `sequence ${s.sequence} <= applied ${current}` };
  }
  const limitDelta = s.creditLimitMinor - BigInt(p.credit_limit_minor);
  const treasuryDelta = s.treasuryUtilisedMinor - BigInt(p.treasury_utilised_minor);
  // Both rows are written even when a delta is 0: the ledger then records that snapshot N was applied.
  await tx.query(
    `INSERT INTO ledger_entries (program_id, kind, component, delta_minor, treasury_sequence, source)
     VALUES ($1, 'TREASURY_REBASE', 'TREASURY_LIMIT', $2, $4, $5),
            ($1, 'TREASURY_REBASE', 'TREASURY_UTILISED', $3, $4, $5)`,
    [s.programId, limitDelta.toString(), treasuryDelta.toString(), s.sequence.toString(), source]
  );
  await tx.query(
    `UPDATE programs SET credit_limit_minor = $2, treasury_utilised_minor = $3, treasury_sequence = $4,
                         updated_at = clock_timestamp()
      WHERE id = $1`,
    [s.programId, s.creditLimitMinor.toString(), s.treasuryUtilisedMinor.toString(), s.sequence.toString()]
  );
  return overcommitted(s.creditLimitMinor, s.treasuryUtilisedMinor, BigInt(p.reserved_minor))
    ? { outcome: 'overcommitted', detail: 'limit below utilisation; new reservations are rejected' }
    : { outcome: 'applied' };
}

/** An incremental treasury change, under the same sequence rule as snapshots. */
export async function applyTreasuryAdjustment(
  tx: Tx,
  a: TreasuryAdjustment,
  source: string
): Promise<TreasuryOutcome> {
  const p = await lockProgram(tx, a.programId);
  if (!p) {
    return { outcome: 'rejected', detail: 'unknown program' };
  }
  if (p.currency !== a.currency) {
    return {
      outcome: 'rejected',
      detail: `currency ${a.currency} is not the program currency ${p.currency}`,
    };
  }
  const current = BigInt(p.treasury_sequence);
  if (a.sequence <= current) {
    return { outcome: 'stale', detail: `sequence ${a.sequence} <= applied ${current}` };
  }
  let limit = BigInt(p.credit_limit_minor);
  let treasury = BigInt(p.treasury_utilised_minor);
  if (a.component === 'LIMIT') {
    limit += a.deltaMinor;
  } else {
    treasury += a.deltaMinor;
  }
  if (limit < 0n || treasury < 0n) {
    return { outcome: 'rejected', detail: 'adjustment would make a treasury figure negative' };
  }
  await tx.query(
    `INSERT INTO ledger_entries (program_id, kind, component, delta_minor, treasury_sequence, source)
     VALUES ($1, 'TREASURY_ADJUSTMENT', $2, $3, $4, $5)`,
    [
      a.programId,
      a.component === 'LIMIT' ? 'TREASURY_LIMIT' : 'TREASURY_UTILISED',
      a.deltaMinor.toString(),
      a.sequence.toString(),
      source,
    ]
  );
  await tx.query(
    `UPDATE programs SET credit_limit_minor = $2, treasury_utilised_minor = $3, treasury_sequence = $4,
                         updated_at = clock_timestamp()
      WHERE id = $1`,
    [a.programId, limit.toString(), treasury.toString(), a.sequence.toString()]
  );
  return overcommitted(limit, treasury, BigInt(p.reserved_minor))
    ? { outcome: 'overcommitted', detail: 'limit below utilisation; new reservations are rejected' }
    : { outcome: 'applied' };
}
