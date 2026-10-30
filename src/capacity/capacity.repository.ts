// All SQL that changes capacity. Every change appends to ledger_entries (the source of truth) and
// updates the programs cache in the same transaction.
//
// Locking, and why there are no deadlocks:
//   reserve   → programs row (conditional UPDATE), then inserts only
//   release   → programs row (SELECT … FOR UPDATE), then its reservations row
//   treasury  → programs row (SELECT … FOR UPDATE), then inserts only
// Every path locks the programs row first and nothing locks it after a reservations row: no cycle.
//
// Time: every ledger row is stamped while its writer holds the programs row lock (a reservation's row
// with its created_at / released_at), so `asOf` reads can wait for writers in flight (ledgerAvailability).
import { randomUUID } from 'node:crypto';

import { type Db, type Tx, withTransaction } from '../db/database.js';
import { type CurrencyCode } from '../money/currencies.js';
import { MAX_TREASURY_MINOR } from '../money/money.js';
import type {
  Availability,
  ReleaseResult,
  Reservation,
  ReserveResult,
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
  /** The program currency, known from pricing: the reservation's amount is in it. */
  currency: CurrencyCode;
  invoiceRef: string;
  invoiceAmountMinor: bigint;
  invoiceCurrency: CurrencyCode;
  amountMinor: bigint;
  fxRate: string;
  fxRateAt: Date;
  fxSource: string;
  source: string;
}

/** reservations columns for RETURNING; the program currency is added in code. */
const RETURNED = `id, program_id, invoice_ref, invoice_amount_minor, invoice_currency, amount_minor, fx_rate,
  fx_rate_at, fx_source, status, created_at, released_at`;

/**
 * The concurrency guard. The capacity check and the write are ONE statement: Postgres locks the row
 * on UPDATE, and a concurrent UPDATE waiting on that lock re-evaluates the WHERE clause against the
 * committed row (READ COMMITTED), so the second of two racers sees the first one's reservation.
 * No row back = insufficient capacity; nothing has been written. The reservation and its ledger row
 * are inserted in the same transaction.
 *
 * One ACTIVE reservation per invoice and program: checked after the guard, with the program row locked.
 * Every reservation of a program is inserted under that lock, so this read sees all committed ones and
 * two racing requests for one invoice cannot both pass. A unique index backs it up.
 */
export async function reserveCapacity(tx: Tx, r: NewReservation): Promise<ReserveResult> {
  const guarded = await tx.query(
    `UPDATE programs
        SET reserved_minor = reserved_minor + $2, updated_at = clock_timestamp()
      WHERE id = $1
        AND credit_limit_minor - treasury_utilised_minor - reserved_minor >= $2
      RETURNING id`,
    [r.programId, r.amountMinor.toString()]
  );
  if (guarded.rowCount === 0) {
    return { ok: false, kind: 'insufficient_capacity' };
  }
  const duplicate = await tx.query(
    `SELECT 1 FROM reservations WHERE program_id = $1 AND invoice_ref = $2 AND status = 'ACTIVE'`,
    [r.programId, r.invoiceRef]
  );
  if (duplicate.rowCount !== 0) {
    // Give the increment back: nothing reaches the ledger, and the caller stores this outcome.
    await tx.query(`UPDATE programs SET reserved_minor = reserved_minor - $2 WHERE id = $1`, [
      r.programId,
      r.amountMinor.toString(),
    ]);
    return { ok: false, kind: 'invoice_already_reserved' };
  }
  const { rows } = await tx.query<Omit<ReservationRow, 'currency'>>(
    `INSERT INTO reservations (id, program_id, invoice_ref, invoice_amount_minor, invoice_currency,
                               amount_minor, fx_rate, fx_rate_at, fx_source, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE')
     RETURNING ${RETURNED}`,
    [
      randomUUID(),
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
  const row = rows[0] as Omit<ReservationRow, 'currency'>;
  await tx.query(
    `INSERT INTO ledger_entries (program_id, kind, component, delta_minor, reservation_id, source, recorded_at)
     VALUES ($1, 'RESERVE', 'LOCAL', $2, $3, $4, $5)`,
    [r.programId, r.amountMinor.toString(), row.id, r.source, row.created_at]
  );
  return { ok: true, reservation: toReservation({ ...row, currency: r.currency }) };
}

/**
 * Release returns exactly the stored amount_minor: never reconverted. `… AND status = 'ACTIVE'`
 * matches once; a second release finds RELEASED and returns the original release unchanged.
 * The program row is locked first (see the header), so released_at is stamped under that lock.
 */
export async function releaseCapacity(tx: Tx, reservationId: string, source: string): Promise<ReleaseResult> {
  const program = await tx.query<{ id: string; currency: string }>(
    `SELECT p.id, p.currency FROM programs p JOIN reservations r ON r.program_id = p.id
      WHERE r.id = $1 FOR UPDATE OF p`,
    [reservationId]
  );
  const p = program.rows[0];
  if (!p) {
    return { ok: false, kind: 'reservation_not_found' };
  }
  const released = await tx.query<Omit<ReservationRow, 'currency'>>(
    `UPDATE reservations SET status = 'RELEASED', released_at = date_trunc('milliseconds', clock_timestamp())
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${RETURNED}`,
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
    [p.id, row.amount_minor]
  );
  await tx.query(
    `INSERT INTO ledger_entries (program_id, kind, component, delta_minor, reservation_id, source, recorded_at)
     VALUES ($1, 'RELEASE', 'LOCAL', $2, $3, $4, $5)`,
    [p.id, (-BigInt(row.amount_minor)).toString(), reservationId, source, row.released_at]
  );
  return {
    ok: true,
    reservation: toReservation({ ...row, currency: p.currency }),
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
 *
 * Stable answers: every ledger row is stamped at insert time while its writer holds the program row
 * lock, and commits right after. Taking FOR SHARE on that row first waits for any such writer, so the
 * fold (a new snapshot, READ COMMITTED) sees every row stamped up to now; a later writer stamps a later
 * time. The same `asOf` therefore gives the same answer whenever it is asked.
 */
export async function ledgerAvailability(
  db: Db,
  programId: string,
  asOf: Date
): Promise<Availability | null> {
  return withTransaction(db, async (tx) => {
    await tx.query('SELECT 1 FROM programs WHERE id = $1 FOR SHARE', [programId]);
    const { rows } = await tx.query<ProgramRow>(
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
  });
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

type Guarded = { ok: true; program: ProgramRow } | { ok: false; result: TreasuryOutcome };

/**
 * The ordering guard every treasury message passes, with the program row locked.
 *  - `newer` (snapshots, full state): any sequence strictly greater than the applied one.
 *  - `next` (adjustments, deltas): exactly applied + 1. A delta applied over a missing one would leave
 *    the treasury figures wrong with no sign of it, so a gap is rejected and the program keeps its last
 *    consistent state until a snapshot rebases it.
 * Equal or lower is stale in both cases.
 */
async function guardTreasury(
  tx: Tx,
  m: { programId: string; currency: string; sequence: bigint },
  rule: 'newer' | 'next'
): Promise<Guarded> {
  const program = await lockProgram(tx, m.programId);
  if (!program) {
    return { ok: false, result: { outcome: 'rejected', detail: 'unknown program' } };
  }
  if (program.currency !== m.currency) {
    return {
      ok: false,
      result: {
        outcome: 'rejected',
        detail: `currency ${m.currency} is not the program currency ${program.currency}`,
      },
    };
  }
  const current = BigInt(program.treasury_sequence);
  if (m.sequence <= current) {
    return {
      ok: false,
      result: { outcome: 'stale', detail: `sequence ${m.sequence} <= applied ${current}` },
    };
  }
  if (rule === 'next' && m.sequence !== current + 1n) {
    return {
      ok: false,
      result: {
        outcome: 'rejected',
        detail: `sequence gap: expected ${current + 1n}, got ${m.sequence}; held until a snapshot`,
      },
    };
  }
  return { ok: true, program };
}

interface TreasuryRow {
  kind: 'TREASURY_REBASE' | 'TREASURY_ADJUSTMENT';
  component: 'TREASURY_LIMIT' | 'TREASURY_UTILISED';
  deltaMinor: bigint;
}

/**
 * Appends the ledger rows and moves the cache to the new treasury figures. All rows of one change share
 * one timestamp, taken now (with the program row locked), so an `asOf` fold sees all of them or none.
 */
async function writeTreasury(
  tx: Tx,
  program: ProgramRow,
  change: { sequence: bigint; limit: bigint; treasury: bigint; rows: TreasuryRow[] },
  source: string
): Promise<TreasuryOutcome> {
  await tx.query(
    `INSERT INTO ledger_entries (program_id, kind, component, delta_minor, treasury_sequence, source, recorded_at)
     SELECT $1, e.kind, e.component, e.delta, $2, $3, t.at
       FROM unnest($4::text[], $5::text[], $6::bigint[]) WITH ORDINALITY AS e(kind, component, delta, n)
      CROSS JOIN (SELECT date_trunc('milliseconds', clock_timestamp()) AS at) t
      ORDER BY e.n`,
    [
      program.id,
      change.sequence.toString(),
      source,
      change.rows.map((r) => r.kind),
      change.rows.map((r) => r.component),
      change.rows.map((r) => r.deltaMinor.toString()),
    ]
  );
  await tx.query(
    `UPDATE programs SET credit_limit_minor = $2, treasury_utilised_minor = $3, treasury_sequence = $4,
                         updated_at = clock_timestamp()
      WHERE id = $1`,
    [program.id, change.limit.toString(), change.treasury.toString(), change.sequence.toString()]
  );
  return change.limit - change.treasury - BigInt(program.reserved_minor) < 0n
    ? { outcome: 'overcommitted', detail: 'limit below utilisation; new reservations are rejected' }
    : { outcome: 'applied' };
}

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
  const g = await guardTreasury(tx, s, 'newer');
  if (!g.ok) {
    return g.result;
  }
  const p = g.program;
  // Both rows are written even when a delta is 0: the ledger then records that snapshot N was applied.
  return writeTreasury(
    tx,
    p,
    {
      sequence: s.sequence,
      limit: s.creditLimitMinor,
      treasury: s.treasuryUtilisedMinor,
      rows: [
        {
          kind: 'TREASURY_REBASE',
          component: 'TREASURY_LIMIT',
          deltaMinor: s.creditLimitMinor - BigInt(p.credit_limit_minor),
        },
        {
          kind: 'TREASURY_REBASE',
          component: 'TREASURY_UTILISED',
          deltaMinor: s.treasuryUtilisedMinor - BigInt(p.treasury_utilised_minor),
        },
      ],
    },
    source
  );
}

/** An incremental treasury change: the next sequence number only (see guardTreasury). */
export async function applyTreasuryAdjustment(
  tx: Tx,
  a: TreasuryAdjustment,
  source: string
): Promise<TreasuryOutcome> {
  const g = await guardTreasury(tx, a, 'next');
  if (!g.ok) {
    return g.result;
  }
  const p = g.program;
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
  // Out of BIGINT range the UPDATE would fail, be retried as if the database were down, and block the
  // partition: a message that can never apply is rejected and acknowledged instead.
  if (limit > MAX_TREASURY_MINOR || treasury > MAX_TREASURY_MINOR) {
    return { outcome: 'rejected', detail: 'adjustment would exceed the largest supported amount' };
  }
  return writeTreasury(
    tx,
    p,
    {
      sequence: a.sequence,
      limit,
      treasury,
      rows: [
        {
          kind: 'TREASURY_ADJUSTMENT',
          component: a.component === 'LIMIT' ? 'TREASURY_LIMIT' : 'TREASURY_UTILISED',
          deltaMinor: a.deltaMinor,
        },
      ],
    },
    source
  );
}
