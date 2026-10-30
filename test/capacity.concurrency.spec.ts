// Invariant 1: no oversubscription under concurrency. Real parallel HTTP, real Postgres, a connection
// pool large enough (40) that all N requests are genuinely in flight at once.
import { dbState, startApp, type TestApp } from './helpers/app.js';

const N = 25;
const AMOUNT = 10_000n; // EUR 100.00
const ROUNDS = 5;

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

describe('capacity under concurrency', () => {
  it(`N concurrent reservations against a limit that fits N-1 → exactly one is rejected and the sum never exceeds the limit (N=${N}, ${ROUNDS} rounds)`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const limit = AMOUNT * BigInt(N - 1);
      const programId = await t.program('EUR', limit);

      // Build every request first, then release them together.
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          t.reserve(programId, {
            invoiceRef: `INV-${round}-${i}`,
            amountMinor: AMOUNT.toString(),
            currency: 'EUR',
          })
        )
      );

      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(N - 1);
      expect(statuses.filter((s) => s === 422)).toHaveLength(1);
      expect(results.find((r) => r.status === 422)?.body.error.code).toBe('insufficient_capacity');

      const s = await dbState(t.db, programId);
      expect(s.reserved).toBe(limit); // the sum of reservations is exactly the limit, never above
      expect(s.reserved).toBeLessThanOrEqual(s.limit);
      expect(s.ledgerReserved).toBe(s.reserved); // the cache equals the ledger
      expect(s.reservations).toBe(N - 1);
    }
  });

  it('an amount one minor unit over the available capacity is rejected and writes nothing', async () => {
    const programId = await t.program('EUR', 50_000n);
    await t.reserve(programId, { invoiceRef: 'INV-A', amountMinor: '30000', currency: 'EUR' });
    const before = await dbState(t.db, programId);

    const res = await t.reserve(programId, { invoiceRef: 'INV-B', amountMinor: '20001', currency: 'EUR' });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'insufficient_capacity',
      message: 'Insufficient capacity on this program.',
    });
    expect(await dbState(t.db, programId)).toEqual(before);

    // Exactly the remaining amount still fits.
    expect(
      (await t.reserve(programId, { invoiceRef: 'INV-C', amountMinor: '20000', currency: 'EUR' })).status
    ).toBe(201);
    expect((await dbState(t.db, programId)).reserved).toBe(50_000n);
  });

  it('concurrent reserves and releases on one program keep the cache equal to the ledger', async () => {
    const programId = await t.program('EUR', 1_000_000n);
    const first = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        t.reserve(programId, { invoiceRef: `INV-M${i}`, amountMinor: '10000', currency: 'EUR' })
      )
    );
    const ids = first.map((r) => r.body.id as string);
    await Promise.all([
      ...ids.slice(0, 10).map((id) => t.call('POST', `/reservations/${id}/release`)),
      ...ids.slice(0, 10).map((id) => t.call('POST', `/reservations/${id}/release`)), // released twice, concurrently
      ...Array.from({ length: 10 }, (_, i) =>
        t.reserve(programId, { invoiceRef: `INV-N${i}`, amountMinor: '5000', currency: 'EUR' })
      ),
    ]);
    const s = await dbState(t.db, programId);
    expect(s.reserved).toBe(10n * 10_000n + 10n * 5_000n);
    expect(s.ledgerReserved).toBe(s.reserved);
  });

  // Proves the load above really interleaves: the same load against the classic broken guard (read the
  // available amount, then write in a second statement) oversubscribes. If this ever stopped failing
  // the broken way, the test above would no longer prove anything.
  it('control: a read-then-write check under the same load does oversubscribe (why the guard is one statement)', async () => {
    const limit = AMOUNT * BigInt(N - 1);
    const programId = await t.program('EUR', limit);

    const brokenReserve = async () => {
      const c = await t.db.connect();
      try {
        await c.query('BEGIN');
        const { rows } = await c.query(
          'SELECT credit_limit_minor - treasury_utilised_minor - reserved_minor AS available FROM programs WHERE id = $1',
          [programId]
        );
        await c.query('SELECT pg_sleep(0.05)'); // the window every read-then-write has, made visible
        if (BigInt(rows[0].available) >= AMOUNT) {
          await c.query('UPDATE programs SET reserved_minor = reserved_minor + $2 WHERE id = $1', [
            programId,
            AMOUNT.toString(),
          ]);
        }
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    };
    await Promise.all(Array.from({ length: N }, brokenReserve));

    expect((await dbState(t.db, programId)).reserved).toBeGreaterThan(limit);
  });
});
