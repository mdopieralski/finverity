// Idempotent local seed: three fictional programs in three currencies (one with a zero exponent).
// Each starts with a PROGRAM_OPENED ledger entry, so the ledger alone explains the starting limit.
import type pg from 'pg';

import { withTransaction } from './database.js';

export interface SeedProgram {
  id: string;
  name: string;
  currency: string;
  creditLimitMinor: bigint;
}

export const SEED_PROGRAMS: SeedProgram[] = [
  {
    id: 'prg_eur_acme',
    name: 'Acme Retail supplier program',
    currency: 'EUR',
    creditLimitMinor: 1_000_000_000n,
  },
  {
    id: 'prg_usd_globex',
    name: 'Globex Manufacturing supplier program',
    currency: 'USD',
    creditLimitMinor: 500_000_000n,
  },
  {
    id: 'prg_jpy_umbrella',
    name: 'Umbrella Logistics supplier program',
    currency: 'JPY',
    creditLimitMinor: 500_000_000n,
  },
];

/** Creates a program and its opening ledger entry; no-op if it already exists. */
export async function openProgram(pool: pg.Pool, p: SeedProgram, source = 'seed'): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO programs (id, name, currency, credit_limit_minor)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [p.id, p.name, p.currency, p.creditLimitMinor.toString()]
    );
    if (inserted.rowCount === 0) {
      return false;
    }
    await tx.query(
      `INSERT INTO ledger_entries (program_id, kind, component, delta_minor, source)
       VALUES ($1, 'PROGRAM_OPENED', 'TREASURY_LIMIT', $2, $3)`,
      [p.id, p.creditLimitMinor.toString(), source]
    );
    return true;
  });
}

export async function seed(pool: pg.Pool): Promise<string[]> {
  const created: string[] = [];
  for (const p of SEED_PROGRAMS) {
    if (await openProgram(pool, p)) {
      created.push(p.id);
    }
  }
  return created;
}
