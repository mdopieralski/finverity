import { createHash } from 'node:crypto';

import type { Db, Tx } from '../db/database.js';

export type Claim =
  { state: 'new' } | { state: 'replay'; status: number; body: unknown } | { state: 'conflict' };

/** sha256 of a canonical JSON form (keys sorted), so key order in the client's body doesn't matter. */
export function requestHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])])
        )
      : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/**
 * Claims (subject, key) inside the caller's transaction. A concurrent request with the same key blocks
 * on the primary key until the first transaction ends, then sees its stored result: that wait is the
 * whole concurrency control for duplicate keys. If the first transaction rolled back, the key is free
 * again and this one proceeds as new.
 */
export async function claimKey(tx: Tx, subject: string, key: string, hash: string): Promise<Claim> {
  const inserted = await tx.query(
    `INSERT INTO idempotency_keys (subject, key, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT (subject, key) DO NOTHING RETURNING key`,
    [subject, key, hash]
  );
  if (inserted.rowCount === 1) {
    return { state: 'new' };
  }
  const { rows } = await tx.query<{
    request_hash: string;
    response_status: number | null;
    response_body: unknown;
  }>(
    'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE subject = $1 AND key = $2',
    [subject, key]
  );
  const row = rows[0];
  if (!row || row.request_hash !== hash) {
    return { state: 'conflict' };
  }
  if (row.response_status === null) {
    // Unreachable: the result is stored in the same transaction that created the row.
    throw new Error('idempotency record without a stored response');
  }
  return { state: 'replay', status: row.response_status, body: row.response_body };
}

export async function storeResult(
  tx: Tx,
  subject: string,
  key: string,
  status: number,
  body: unknown
): Promise<void> {
  await tx.query(
    'UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE subject = $1 AND key = $2',
    [subject, key, status, JSON.stringify(body)]
  );
}

/** The stored result for (subject, key), read without claiming it. */
export async function findStored(db: Db, subject: string, key: string, hash: string): Promise<Claim | null> {
  const { rows } = await db.query<{
    request_hash: string;
    response_status: number | null;
    response_body: unknown;
  }>(
    'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE subject = $1 AND key = $2',
    [subject, key]
  );
  const row = rows[0];
  if (!row || row.response_status === null) {
    return null;
  }
  return row.request_hash === hash
    ? { state: 'replay', status: row.response_status, body: row.response_body }
    : { state: 'conflict' };
}
