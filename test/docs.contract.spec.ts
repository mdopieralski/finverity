// The API docs match the API (ingrid's group F, adapted): the served spec is the exported one, its
// version follows package.json, every real response validates against it, and every error message it
// documents is the one the service returns.
import { readFileSync } from 'node:fs';

import { ERROR_TABLE } from '../src/errors/error-table.js';
import { dbState, startApp, type TestApp } from './helpers/app.js';
import { operations, specValidator } from './helpers/spec.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const exported = JSON.parse(readFileSync(new URL('../docs/api/openapi.json', import.meta.url), 'utf8'));

let t: TestApp;
let expectMatchesSpec: ReturnType<typeof specValidator>;
beforeAll(async () => {
  t = await startApp();
  expectMatchesSpec = specValidator(t.spec);
});
afterAll(() => t.close());

describe('API docs match the API', () => {
  it('/openapi.json serves the spec, versioned from package.json, identical to docs/api/openapi.json', async () => {
    const res = await t.call('GET', '/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.info.version).toBe(pkg.version);
    expect(res.body).toEqual(exported); // run `pnpm run docs:export` if this fails
    expect(
      operations(res.body)
        .map(([m, p]) => `${m} ${p}`)
        .sort()
    ).toEqual([
      'GET /programs/{programId}/availability',
      'GET /programs/{programId}/reservations',
      'POST /programs/{programId}/reservations',
      'POST /reservations/{reservationId}/release',
    ]);
  });

  it('/docs serves Swagger UI, and every asset it loads answers with the same credentials', async () => {
    const auth = { authorization: `Basic ${Buffer.from(`r:${t.token()}`).toString('base64')}` };
    const page = await t.call('GET', '/docs/', { token: null, headers: auth });
    expect(page.status).toBe(200);
    expect(page.text).toContain('swagger-ui');
    const assets = [...page.text.matchAll(/(?:href|src)="(?:\.\/)?([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(assets.length).toBeGreaterThanOrEqual(3);
    for (const asset of assets.filter((a) => !a.startsWith('http'))) {
      const path = asset.startsWith('/') ? asset : `/docs/${asset}`;
      expect((await t.call('GET', path, { token: null, headers: auth })).status, path).toBe(200);
    }
  });

  it('/docs/ serves only the files its page loads, nothing else from swagger-ui-dist', async () => {
    const auth = { authorization: `Basic ${Buffer.from(`r:${t.token()}`).toString('base64')}` };
    for (const path of [
      '/docs/package.json',
      '/docs/README.md',
      '/docs/index.html',
      '/docs/swagger-initializer.js',
      '/docs/swagger-ui.js',
      '/docs/swagger-ui-bundle.js.map',
      '/docs/oauth2-redirect.html',
      '/docs/..%2Fpackage.json',
    ]) {
      expect((await t.call('GET', path, { token: null, headers: auth })).status, path).toBe(404);
    }
  });

  it('every documented error example carries the exact message from the error table', () => {
    for (const [method, path] of operations(t.spec)) {
      const op = (t.spec.paths[path] as Record<string, any>)[method.toLowerCase()];
      for (const [status, response] of Object.entries<any>(op.responses)) {
        const content = response.content?.['application/json'];
        const examples = content?.example
          ? [content.example]
          : Object.values<any>(content?.examples ?? {}).map((e) => e.value);
        for (const ex of examples.filter((e) => e?.error)) {
          const entry = ERROR_TABLE[ex.error.code as keyof typeof ERROR_TABLE];
          expect(entry, `${method} ${path} ${status}: unknown code ${ex.error.code}`).toBeTruthy();
          expect(ex.error.message).toBe(entry.message);
          expect(String(entry.status)).toBe(status);
        }
      }
    }
  });

  it('real responses validate against the spec: success and every error status', async () => {
    const programId = await t.program('EUR', 100_000n);
    const body = { invoiceRef: 'INV-8001', amountMinor: '60000', currency: 'EUR' };
    const created = await t.reserve(programId, body, 'contract-key');
    const cases: [Awaited<ReturnType<TestApp['call']>>, string, string][] = [
      [created, 'POST', '/programs/{programId}/reservations'],
      [await t.reserve(programId, body, 'contract-key'), 'POST', '/programs/{programId}/reservations'],
      [
        await t.reserve(programId, { ...body, amountMinor: '1' }, 'contract-key'),
        'POST',
        '/programs/{programId}/reservations',
      ],
      [
        await t.reserve(programId, { ...body, amountMinor: '60000' }),
        'POST',
        '/programs/{programId}/reservations',
      ],
      [
        await t.reserve(programId, { ...body, amountMinor: '1.5' }),
        'POST',
        '/programs/{programId}/reservations',
      ],
      [await t.reserve('prg_nope', body), 'POST', '/programs/{programId}/reservations'],
      [await t.reserve(programId, body, 'k', 'bad'), 'POST', '/programs/{programId}/reservations'],
      [
        await t.call('GET', `/programs/${programId}/availability`),
        'GET',
        '/programs/{programId}/availability',
      ],
      [
        await t.call('GET', `/programs/${programId}/availability?asOf=2026-01-01T00:00:00Z`),
        'GET',
        '/programs/{programId}/availability',
      ],
      [
        await t.call('GET', `/programs/${programId}/reservations?limit=1`),
        'GET',
        '/programs/{programId}/reservations',
      ],
      [
        await t.call('GET', `/programs/${programId}/reservations?limit=0`),
        'GET',
        '/programs/{programId}/reservations',
      ],
      [
        await t.call('POST', `/reservations/${created.body.id}/release`),
        'POST',
        '/reservations/{reservationId}/release',
      ],
      [
        await t.call('POST', '/reservations/00000000-0000-4000-8000-000000000000/release'),
        'POST',
        '/reservations/{reservationId}/release',
      ],
    ];
    const statuses = new Set<number>();
    for (const [res, method, path] of cases) {
      expectMatchesSpec(res, method, path);
      statuses.add(res.status);
    }
    expect([...statuses].sort()).toEqual([200, 201, 400, 401, 404, 409, 422]);
    expect((await dbState(t.db, programId)).reserved).toBe(0n);
  });
});
