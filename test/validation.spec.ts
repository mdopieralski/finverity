// Input is validated at the edge (400 with a fixed message and field names), and no response ever
// carries internal detail: no SQL, no stack, no driver message.
import { ERROR_TABLE } from '../src/errors/error-table.js';
import { dbState, startApp, type TestApp } from './helpers/app.js';

let t: TestApp;
let programId: string;
beforeAll(async () => {
  t = await startApp();
  programId = await t.program('EUR', 10_000_000n);
});
afterAll(() => t.close());

const ok = { invoiceRef: 'INV-6001', amountMinor: '100', currency: 'EUR' };

describe('reservation input', () => {
  it.each([
    ['a fractional amount', { ...ok, amountMinor: '1500.50' }, 'invalid_amount'],
    ['an amount as a JSON number', { ...ok, amountMinor: 1500 }, 'invalid_amount'],
    ['a fractional JSON number', { ...ok, amountMinor: 1500.5 }, 'invalid_amount'],
    ['a negative amount', { ...ok, amountMinor: '-100' }, 'invalid_amount'],
    ['a zero amount', { ...ok, amountMinor: '0' }, 'invalid_amount'],
    ['an exponent', { ...ok, amountMinor: '1e5' }, 'invalid_amount'],
    ['an amount beyond BIGINT', { ...ok, amountMinor: '9'.repeat(19) }, 'invalid_amount'],
    ['an unknown currency', { ...ok, currency: 'XYZ' }, 'invalid_request'],
    ['a lowercase currency', { ...ok, currency: 'eur' }, 'invalid_request'],
    ['a missing invoiceRef', { amountMinor: '100', currency: 'EUR' }, 'invalid_request'],
    ['an unknown field', { ...ok, discount: '5' }, 'invalid_request'],
    ['an array body', [ok], 'invalid_request'],
  ])('%s → 400 and nothing written', async (_name, body, code) => {
    const before = await dbState(t.db, programId);
    const res = await t.reserve(programId, body as Record<string, unknown>);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.message).toBe(ERROR_TABLE[code as keyof typeof ERROR_TABLE].message);
    expect(await dbState(t.db, programId)).toEqual(before);
  });

  it('field names are reported, values never are', async () => {
    const res = await t.reserve(programId, { ...ok, amountMinor: '1500.50' });
    expect(res.body.error.fields).toEqual(['amountMinor']);
    expect(res.text).not.toContain('1500.50');
  });

  it('a missing or malformed Idempotency-Key → 400', async () => {
    for (const headers of [
      {},
      { 'idempotency-key': 'has space' },
      { 'idempotency-key': 'x'.repeat(256) },
    ] as Record<string, string>[]) {
      const res = await t.call('POST', `/programs/${programId}/reservations`, { body: ok, headers });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('idempotency_key_required');
    }
  });

  it('malformed JSON → 400 invalid_request, with no parser detail', async () => {
    const res = await t.call('POST', `/programs/${programId}/reservations`, {
      rawBody: '{"amountMinor": ',
      headers: { 'idempotency-key': 'k' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'invalid_request',
      message: 'The request is invalid.',
      requestId: expect.any(String),
    });
  });
});

describe('ids, queries and 404s', () => {
  it.each([
    ['GET', '/programs/NOT-AN-ID/availability', 400, 'invalid_request'],
    ['GET', '/programs/prg_missing/availability', 404, 'program_not_found'],
    ['GET', '/programs/prg_missing/reservations', 404, 'program_not_found'],
    ['POST', '/reservations/not-a-uuid/release', 400, 'invalid_request'],
    ['POST', '/reservations/00000000-0000-4000-8000-000000000000/release', 404, 'reservation_not_found'],
    ['GET', '/nowhere', 404, 'route_not_found'],
  ])('%s %s → %i %s', async (method, path, status, code) => {
    const res = await t.call(method, path);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  it('reserving on an unknown program → 404 and the key is not consumed', async () => {
    const res = await t.reserve('prg_missing', ok, 'missing-key');
    expect(res.status).toBe(404);
    const { rows } = await t.db.query(
      "SELECT count(*)::int AS n FROM idempotency_keys WHERE key = 'missing-key'"
    );
    expect(rows[0].n).toBe(0);
  });

  it.each([
    ['asOf in the future', `asOf=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`],
    ['asOf without an offset', 'asOf=2026-10-28T10:00:00'],
    ['asOf not a date', 'asOf=yesterday'],
    ['an unknown parameter', 'foo=bar'],
  ])('availability with %s → 400', async (_name, qs) => {
    const res = await t.call('GET', `/programs/${programId}/availability?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it.each(['limit=0', 'limit=101', 'limit=abc', 'status=OPEN', 'cursor=%%%', 'cursor=bm90LWEtY3Vyc29y'])(
    'list with %s → 400',
    async (qs) => {
      expect((await t.call('GET', `/programs/${programId}/reservations?${qs}`)).status).toBe(400);
    }
  );
});

describe('no internal detail leaks', () => {
  it('with the database unreachable: 503, the constant message, nothing about the driver', async () => {
    const down = await startApp({ databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    try {
      for (const res of [
        await down.call('GET', '/programs/prg_eur_acme/availability'),
        await down.reserve('prg_eur_acme', ok),
      ]) {
        expect(res.status).toBe(503);
        expect(res.body.error).toEqual({
          code: 'service_unavailable',
          message: 'Service temporarily unavailable.',
          requestId: expect.any(String),
        });
        expect(res.text).not.toMatch(/ECONNREFUSED|postgres|127\.0\.0\.1|stack|at /i);
      }
    } finally {
      await down.app.close();
    }
  });

  it('every error body has exactly code, message, requestId (and field names), and echoes X-Request-Id', async () => {
    const res = await t.call('GET', '/programs/prg_missing/availability', {
      headers: { 'x-request-id': 'trace-abc.1' },
    });
    expect(res.headers.get('x-request-id')).toBe('trace-abc.1');
    expect(res.body).toEqual({
      error: { code: 'program_not_found', message: 'Program not found.', requestId: 'trace-abc.1' },
    });
  });
});
