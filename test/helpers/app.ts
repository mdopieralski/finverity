// Boots the real app (src/create-app.ts) on a random port against a fresh database, and talks to it
// over real HTTP with fetch. Nothing is mocked except the FX rate source, which tests move on purpose.
import { randomBytes, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { OpenAPIObject } from '@nestjs/swagger';
import pg from 'pg';
import { inject } from 'vitest';

import type { Config } from '../../src/config/config.js';
import { createApp } from '../../src/create-app.js';
import { createPool } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { openProgram } from '../../src/db/seed.js';
import { buildDocument } from '../../src/docs/openapi.js';
import type { FxQuote, FxRateProvider } from '../../src/fx/fx-rate.provider.js';
import type { CurrencyCode } from '../../src/money/currencies.js';
import { TreasuryHandler } from '../../src/treasury/treasury.handler.js';

export const JWT_SECRET = 'test-secret-0123456789abcdef';

/** An FX source the test controls: set a rate, reserve, move it, release. */
export class MutableFxRates implements FxRateProvider {
  private readonly rates = new Map<string, FxQuote>();

  set(from: CurrencyCode, to: CurrencyCode, rate: string, asOf = new Date()): void {
    this.rates.set(`${from}/${to}`, { rate, asOf, source: 'test-fixed' });
  }

  async getRate(from: CurrencyCode, to: CurrencyCode): Promise<FxQuote | null> {
    return this.rates.get(`${from}/${to}`) ?? null;
  }
}

export async function createDatabase(): Promise<string> {
  const admin = new pg.Client({ connectionString: inject('pgAdminUrl') });
  const name = `t_${randomBytes(6).toString('hex')}`;
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(inject('pgAdminUrl'));
  url.pathname = `/${name}`;
  return url.toString();
}

export interface Res<T = any> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export interface TestApp {
  url: string;
  app: INestApplication;
  config: Config;
  /** A separate pool for assertions and direct SQL. */
  db: pg.Pool;
  fx: MutableFxRates;
  spec: OpenAPIObject;
  treasury: TreasuryHandler;
  token(sub?: string, opts?: { expiresIn?: number; secret?: string }): string;
  call<T = any>(
    method: string,
    path: string,
    opts?: { token?: string | null; body?: unknown; rawBody?: string; headers?: Record<string, string> }
  ): Promise<Res<T>>;
  reserve<T = any>(
    programId: string,
    body: Record<string, unknown>,
    key?: string,
    token?: string
  ): Promise<Res<T>>;
  /** Creates a program with an opening ledger entry; returns its id. */
  program(currency: CurrencyCode, creditLimitMinor: bigint): Promise<string>;
  close(): Promise<void>;
}

export async function startApp(overrides: Partial<Config> = {}): Promise<TestApp> {
  const databaseUrl = overrides.databaseUrl ?? (await createDatabase());
  const db = createPool(databaseUrl, 40);
  if (!overrides.databaseUrl) {
    await migrate(db);
  }
  const fx = new MutableFxRates();
  const config: Config = {
    port: 0,
    databaseUrl,
    dbPoolSize: 40,
    jwtSecret: JWT_SECRET,
    jwtIssuer: undefined,
    jwtAudience: undefined,
    kafkaEnabled: false,
    kafkaBrokers: [],
    kafkaTopic: 'treasury.capacity.v1',
    kafkaGroupId: `test-${randomUUID()}`,
    apiDocs: true,
    fxRates: '',
    ...overrides,
  };
  const app = await createApp(config, { fxRateProvider: fx });
  await app.listen(0, '127.0.0.1');
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const jwt = new JwtService({ secret: JWT_SECRET });
  const defaultToken = jwt.sign({ sub: 'tester' }, { expiresIn: 3600 });

  const call: TestApp['call'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const token = opts.token === undefined ? defaultToken : opts.token;
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    let body: string | undefined;
    if (opts.rawBody !== undefined || opts.body !== undefined) {
      headers['content-type'] ??= 'application/json';
      body = opts.rawBody ?? JSON.stringify(opts.body);
    }
    const res = await fetch(`${url}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON (e.g. the Swagger UI page)
    }
    return { status: res.status, headers: res.headers, body: parsed as any, text };
  };

  return {
    url,
    app,
    config,
    db,
    fx,
    spec: buildDocument(app),
    treasury: app.get(TreasuryHandler),
    token: (sub = 'tester', o = {}) =>
      new JwtService({ secret: o.secret ?? JWT_SECRET }).sign({ sub }, { expiresIn: o.expiresIn ?? 3600 }),
    call,
    reserve: (programId, body, key = randomUUID(), token) =>
      call('POST', `/programs/${programId}/reservations`, {
        body,
        headers: { 'idempotency-key': key },
        ...(token ? { token } : {}),
      }),
    program: async (currency, creditLimitMinor) => {
      const id = `prg_t_${randomBytes(5).toString('hex')}`;
      await openProgram(db, { id, name: `Test program ${id}`, currency, creditLimitMinor }, 'test');
      return id;
    },
    close: async () => {
      await app.close();
      await db.end();
    },
  };
}

/** Availability straight from the database: cache columns and the ledger fold, for assertions. */
export async function dbState(db: pg.Pool, programId: string) {
  const { rows } = await db.query(
    `SELECT p.credit_limit_minor::text AS limit, p.treasury_utilised_minor::text AS treasury,
            p.reserved_minor::text AS reserved,
            (SELECT COALESCE(SUM(delta_minor), 0) FROM ledger_entries WHERE program_id = p.id AND component = 'LOCAL')::text AS ledger_reserved,
            (SELECT COALESCE(SUM(delta_minor), 0) FROM ledger_entries WHERE program_id = p.id AND component = 'TREASURY_LIMIT')::text AS ledger_limit,
            (SELECT COALESCE(SUM(delta_minor), 0) FROM ledger_entries WHERE program_id = p.id AND component = 'TREASURY_UTILISED')::text AS ledger_treasury,
            (SELECT COUNT(*) FROM ledger_entries WHERE program_id = p.id)::int AS ledger_rows,
            (SELECT COUNT(*) FROM reservations WHERE program_id = p.id)::int AS reservations
       FROM programs p WHERE p.id = $1`,
    [programId]
  );
  const r = rows[0];
  return {
    limit: BigInt(r.limit),
    treasury: BigInt(r.treasury),
    reserved: BigInt(r.reserved),
    ledgerReserved: BigInt(r.ledger_reserved),
    ledgerLimit: BigInt(r.ledger_limit),
    ledgerTreasury: BigInt(r.ledger_treasury),
    ledgerRows: r.ledger_rows as number,
    reservations: r.reservations as number,
  };
}

let offset = 0;
/** Hands a treasury message to the consumer's handler, as Kafka would. */
export function deliver(t: TestApp, message: Record<string, unknown>) {
  return t.treasury.handle(JSON.stringify(message), {
    topic: 'treasury.capacity.v1',
    partition: 0,
    offset: String(offset++),
  });
}

export const snapshot = (
  programId: string,
  seq: number,
  limit: bigint,
  utilised: bigint,
  currency = 'EUR',
  id = randomUUID()
) => ({
  messageId: `tre-${id}`,
  type: 'SNAPSHOT',
  programId,
  treasurySequence: String(seq),
  currency,
  creditLimitMinor: limit.toString(),
  treasuryUtilisedMinor: utilised.toString(),
});
