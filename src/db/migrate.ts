// Applies migrations/NNN_*.sql in order, each in its own transaction, once. An advisory lock makes
// concurrent starts (several replicas) safe. Usage: `pnpm run migrate` or migrate(pool) at start-up.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

import { createPool } from './database.js';

// src/db/ when run from source (tests), dist/src/db/ when built: migrations/ is at the repo root either way.
const MIGRATIONS_DIR = ['../../migrations/', '../../../migrations/']
  .map((p) => fileURLToPath(new URL(p, import.meta.url)))
  .find((p) => existsSync(p)) as string;
const LOCK_ID = 7_220_011; // arbitrary, constant: "program-capacity migrations"

export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
    .sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
    );
    for (const file of files.filter((f) => !done.has(f))) {
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(`${dir}/${file}`, 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  const pool = createPool(url, 1);
  const applied = await migrate(pool);
  process.stdout.write(`${JSON.stringify({ msg: 'migrations applied', applied })}\n`);
  await pool.end();
}
