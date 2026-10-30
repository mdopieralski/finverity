// Invariant 4: convert once, at reservation time; release exactly what was taken.
import { dbState, startApp, type TestApp } from './helpers/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

const available = async (programId: string) =>
  (await t.call('GET', `/programs/${programId}/availability`)).body.availableMinor as string;

describe('currency', () => {
  it('reserving at rate A and releasing after the rate moves to B returns availability to exactly its starting value', async () => {
    const programId = await t.program('EUR', 1_000_000_000n);
    const start = await available(programId);
    const rateAt = new Date('2026-10-28T09:00:00.000Z');
    t.fx.set('USD', 'EUR', '0.909091', rateAt); // rate A

    const r = await t.reserve(programId, { invoiceRef: 'INV-4001', amountMinor: '1234567', currency: 'USD' });
    expect(r.status).toBe(201);
    // USD 12,345.67 × 0.909091 = EUR 11,223.337486 → rounded up to 11,223.34
    expect(r.body).toMatchObject({
      amountMinor: '1122334',
      currency: 'EUR',
      invoice: { amountMinor: '1234567', currency: 'USD' },
      fx: { rate: '0.909091', rateAt: rateAt.toISOString(), source: 'test-fixed' },
    });
    expect(BigInt(await available(programId))).toBe(BigInt(start) - 1_122_334n);

    t.fx.set('USD', 'EUR', '0.85'); // rate B: reconverting would give back EUR 10,493.82
    const released = await t.call('POST', `/reservations/${r.body.id}/release`);

    expect(released.status).toBe(200);
    expect(released.body.amountMinor).toBe('1122334');
    expect(await available(programId)).toBe(start);
    const s = await dbState(t.db, programId);
    expect(s.reserved).toBe(0n);
    expect(s.ledgerReserved).toBe(0n);
  });

  it('a reservation stores the rate and its timestamp; a same-currency one stores rate 1', async () => {
    const programId = await t.program('EUR', 1_000_000_000n);
    const r = await t.reserve(programId, { invoiceRef: 'INV-4002', amountMinor: '500000', currency: 'EUR' });
    expect(r.body).toMatchObject({ amountMinor: '500000', fx: { rate: '1', source: 'same-currency' } });
    const { rows } = await t.db.query(
      'SELECT fx_rate::text, fx_rate_at, fx_source FROM reservations WHERE id = $1',
      [r.body.id]
    );
    expect(Number(rows[0].fx_rate)).toBe(1);
    expect(rows[0].fx_rate_at).toBeInstanceOf(Date);
  });

  it('JPY has no minor unit: EUR 100.00 at 162.5 reserves exactly ¥16,250', async () => {
    const programId = await t.program('JPY', 500_000_000n);
    t.fx.set('EUR', 'JPY', '162.5');
    const r = await t.reserve(programId, { invoiceRef: 'INV-4003', amountMinor: '10000', currency: 'EUR' });
    expect(r.body).toMatchObject({ amountMinor: '16250', currency: 'JPY', exponent: 0 });
    t.fx.set('EUR', 'JPY', '170');
    await t.call('POST', `/reservations/${r.body.id}/release`);
    expect(await available(programId)).toBe('500000000');
  });

  it('a JPY invoice into a EUR program rounds up to the next cent', async () => {
    const programId = await t.program('EUR', 1_000_000n);
    t.fx.set('JPY', 'EUR', '0.006154');
    const r = await t.reserve(programId, { invoiceRef: 'INV-4004', amountMinor: '1001', currency: 'JPY' });
    // ¥1,001 × 0.006154 = EUR 6.160154 → 617 cents
    expect(r.body.amountMinor).toBe('617');
  });

  it('no rate for the pair → 422 fx_rate_unavailable, nothing written, and the key can be retried', async () => {
    const programId = await t.program('EUR', 1_000_000n);
    const before = await dbState(t.db, programId);
    const res = await t.reserve(
      programId,
      { invoiceRef: 'INV-4005', amountMinor: '100', currency: 'GBP' },
      'gbp-key'
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('fx_rate_unavailable');
    expect(await dbState(t.db, programId)).toEqual(before);

    t.fx.set('GBP', 'EUR', '1.17');
    expect(
      (await t.reserve(programId, { invoiceRef: 'INV-4005', amountMinor: '100', currency: 'GBP' }, 'gbp-key'))
        .status
    ).toBe(201);
  });
});
