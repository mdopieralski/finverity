import pg from 'pg';

export const PG_POOL = Symbol('PG_POOL');

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(databaseUrl: string, max: number): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max, application_name: 'program-capacity' });
  // An idle client erroring (e.g. the DB restarting) must not crash the process; the next query reconnects.
  pool.on('error', () => undefined);
  return pool;
}

/**
 * Runs `fn` in one READ COMMITTED transaction: COMMIT if it returns, ROLLBACK if it throws.
 * READ COMMITTED is enough for every write path here because each guard is a single conditional
 * statement or runs under a row lock (see capacity.repository.ts).
 */
export async function withTransaction<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
