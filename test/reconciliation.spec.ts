// Invariant 3: reconciliation ordering. Snapshots apply only with a strictly greater treasury_sequence,
// and rebase only the treasury-owned component: local ACTIVE reservations stay on top.
// Messages are handed to the consumer's handler exactly as Kafka would (the broker path is covered in
// idempotency.spec.ts); that keeps the ordering cases precise.
import { randomUUID } from 'node:crypto';

import { dbState, deliver, snapshot, startApp, type TestApp } from './helpers/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

const availability = async (programId: string) =>
  (await t.call('GET', `/programs/${programId}/availability`)).body as Record<string, string>;

describe('reconciliation snapshots', () => {
  it('an older snapshot does not roll the state back', async () => {
    const programId = await t.program('EUR', 1_000_000_000n);
    expect(await deliver(t, snapshot(programId, 10, 800_000_000n, 50_000_000n))).toBe('applied');
    const after10 = await availability(programId);
    const rowsAfter10 = (await dbState(t.db, programId)).ledgerRows;

    // Older (9) and equal (10, a different message) both arrive late.
    expect(await deliver(t, snapshot(programId, 9, 2_000_000_000n, 0n))).toBe('stale');
    expect(await deliver(t, snapshot(programId, 10, 2_000_000_000n, 0n))).toBe('stale');

    expect(await availability(programId)).toEqual(after10);
    expect(after10).toMatchObject({
      creditLimitMinor: '800000000',
      treasuryUtilisedMinor: '50000000',
      treasurySequence: '10',
    });
    expect((await dbState(t.db, programId)).ledgerRows).toBe(rowsAfter10);
    const { rows } = await t.db.query(
      `SELECT outcome, count(*)::int AS n FROM processed_messages WHERE outcome = 'stale' AND detail LIKE 'sequence %' GROUP BY outcome`
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('a snapshot does not wipe local active reservations', async () => {
    const programId = await t.program('EUR', 1_000_000_000n);
    const r = await t.reserve(programId, {
      invoiceRef: 'INV-3001',
      amountMinor: '12500000',
      currency: 'EUR',
    });
    expect(r.status).toBe(201);

    // Treasury's full state knows nothing about our reservation; it must not erase it.
    expect(await deliver(t, snapshot(programId, 1, 900_000_000n, 100_000_000n))).toBe('applied');

    const a = await availability(programId);
    expect(a).toMatchObject({
      creditLimitMinor: '900000000',
      treasuryUtilisedMinor: '100000000',
      reservedMinor: '12500000',
      availableMinor: String(900_000_000 - 100_000_000 - 12_500_000),
    });
    const listed = await t.call('GET', `/programs/${programId}/reservations?status=ACTIVE`);
    expect(listed.body.items.map((i: { id: string }) => i.id)).toEqual([r.body.id]);

    // And it can still be released, giving back exactly what it took.
    expect((await t.call('POST', `/reservations/${r.body.id}/release`)).status).toBe(200);
    expect((await availability(programId)).availableMinor).toBe('800000000');
    const s = await dbState(t.db, programId);
    expect([s.ledgerLimit, s.ledgerTreasury, s.ledgerReserved]).toEqual([s.limit, s.treasury, s.reserved]);
  });

  it('a limit cut below utilisation is applied, availability goes negative and new reservations are rejected', async () => {
    const programId = await t.program('EUR', 1_000_000n);
    await t.reserve(programId, { invoiceRef: 'INV-3002', amountMinor: '600000', currency: 'EUR' });

    expect(await deliver(t, snapshot(programId, 1, 500_000n, 0n))).toBe('overcommitted');

    expect((await availability(programId)).availableMinor).toBe('-100000');
    expect(
      (await t.reserve(programId, { invoiceRef: 'INV-3003', amountMinor: '1', currency: 'EUR' })).status
    ).toBe(422);
    expect((await dbState(t.db, programId)).reserved).toBe(600_000n); // nothing was cancelled
  });

  it('adjustments follow the same sequence rule and move only the treasury component', async () => {
    const programId = await t.program('EUR', 1_000_000n);
    const adj = (seq: number, component: string, delta: string) => ({
      messageId: `tre-${randomUUID()}`,
      type: 'ADJUSTMENT',
      programId,
      treasurySequence: String(seq),
      currency: 'EUR',
      component,
      deltaMinor: delta,
    });
    expect(await deliver(t, adj(1, 'UTILISED', '200000'))).toBe('applied');
    expect(await deliver(t, adj(2, 'LIMIT', '-100000'))).toBe('applied');
    expect(await deliver(t, adj(2, 'LIMIT', '-900000'))).toBe('stale');
    expect(await deliver(t, adj(3, 'UTILISED', '-300000'))).toBe('rejected'); // would go negative

    expect(await availability(programId)).toMatchObject({
      creditLimitMinor: '900000',
      treasuryUtilisedMinor: '200000',
      availableMinor: '700000',
      treasurySequence: '2',
    });
  });

  it('a malformed message or one for another currency is recorded as rejected and acknowledged', async () => {
    const programId = await t.program('EUR', 1_000_000n);
    expect(await deliver(t, { messageId: `tre-${randomUUID()}`, type: 'SNAPSHOT', programId })).toBe(
      'rejected'
    );
    expect(await deliver(t, snapshot(programId, 1, 1n, 0n, 'USD'))).toBe('rejected');
    expect(await deliver(t, snapshot('prg_does_not_exist', 1, 1n, 0n))).toBe('rejected');
    expect(
      await t.treasury.handle('not json', { topic: 'treasury.capacity.v1', partition: 1, offset: '77' })
    ).toBe('rejected');
    expect((await availability(programId)).creditLimitMinor).toBe('1000000');
  });
});
