// Every endpoint is authenticated, availability reads and the docs included. The list of endpoints
// comes from the OpenAPI document itself, so an endpoint added later is covered on arrival.
import { JwtService } from '@nestjs/jwt';

import { JWT_SECRET, startApp, type TestApp } from './helpers/app.js';
import { operations } from './helpers/spec.js';

let t: TestApp;
let programId: string;
let reservationId: string;
beforeAll(async () => {
  t = await startApp();
  programId = await t.program('EUR', 1_000_000n);
  reservationId = (
    await t.reserve(programId, { invoiceRef: 'INV-5001', amountMinor: '100', currency: 'EUR' })
  ).body.id;
});
afterAll(() => t.close());

const concrete = (path: string) =>
  path.replace('{programId}', programId).replace('{reservationId}', reservationId);

const badTokens = (): [string, string | null][] => [
  ['no token', null],
  [
    'a token signed with another key',
    new JwtService({ secret: 'another-secret-0123456789' }).sign({ sub: 'x' }),
  ],
  [
    'an expired token',
    new JwtService({ secret: JWT_SECRET }).sign({ sub: 'x', exp: Math.floor(Date.now() / 1000) - 60 }),
  ],
  ['a token without sub', new JwtService({ secret: JWT_SECRET }).sign({ role: 'x' }, { expiresIn: 3600 })],
  ['a token without exp (never expires)', new JwtService({ secret: JWT_SECRET }).sign({ sub: 'x' })],
  ['an alg=none token', 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ4In0.'],
  ['garbage', 'not-a-jwt'],
];

describe('no endpoint answers without a valid token', () => {
  it('the spec lists exactly the four operations, each requiring the jwt scheme', () => {
    const ops = operations(t.spec);
    expect(ops).toHaveLength(4);
    for (const [method, path] of ops) {
      const op = (t.spec.paths[path] as Record<string, { security?: unknown[] }>)[method.toLowerCase()];
      expect(op?.security ?? t.spec.security, `${method} ${path}`).toEqual([{ jwt: [] }]);
    }
  });

  it.each(badTokens())('every documented operation → 401 with %s', async (_name, token) => {
    for (const [method, path] of operations(t.spec)) {
      const res = await t.call(method, concrete(path), {
        token,
        ...(method === 'POST' ? { body: { invoiceRef: 'INV-X', amountMinor: '1', currency: 'EUR' } } : {}),
        headers: { 'idempotency-key': 'k' },
      });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'unauthenticated', message: 'Authentication required.' });
      expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message', 'requestId']);
    }
  });

  it('a valid token is accepted', async () => {
    expect((await t.call('GET', `/programs/${programId}/availability`)).status).toBe(200);
  });

  it('an unauthenticated request writes nothing', async () => {
    const res = await t.reserve(
      programId,
      { invoiceRef: 'INV-5002', amountMinor: '100', currency: 'EUR' },
      'k2',
      'nope'
    );
    expect(res.status).toBe(401);
    const { rows } = await t.db.query('SELECT count(*)::int AS n FROM reservations WHERE invoice_ref = $1', [
      'INV-5002',
    ]);
    expect(rows[0].n).toBe(0);
  });
});

describe('the docs are behind the same JWT', () => {
  const basic = (password: string) => `Basic ${Buffer.from(`reviewer:${password}`).toString('base64')}`;

  it.each([
    '/docs',
    '/docs/',
    '/openapi.json',
    '/docs-json',
    '/docs/swagger-ui-init.js',
    // Express matches routes case-insensitively and with an optional trailing slash: so must the guard.
    '/DOCS',
    '/Docs/',
    '/OpenAPI.json',
    '/OPENAPI.JSON',
    '/openapi.json/',
    '/DOCS/swagger-ui-init.js',
    '/Docs/swagger-ui.css',
    '/%64ocs/',
  ])('%s → 401 without credentials', async (path) => {
    const res = await t.call('GET', path, { token: null });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm=/);
  });

  it('Swagger UI opens with Basic auth whose password is a JWT; a wrong password is 401', async () => {
    expect(
      (await t.call('GET', '/docs/', { token: null, headers: { authorization: basic(t.token()) } })).status
    ).toBe(200);
    expect(
      (await t.call('GET', '/docs/', { token: null, headers: { authorization: basic('wrong') } })).status
    ).toBe(401);
  });

  it('/openapi.json accepts a Bearer token', async () => {
    const res = await t.call('GET', '/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
  });
});
