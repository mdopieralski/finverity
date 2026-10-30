// The ledger is the source of truth: availability can be recomputed from ledger rows alone, at any past
// instant (?asOf=), and the programs cache always equals that fold.
import { randomUUID } from 'node:crypto';

import { dbState, deliver, type Res, snapshot, startApp, type TestApp } from './helpers/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

const at = (programId: string, asOf?: Date) =>
  t.call(
    'GET',
    `/programs/${programId}/availability${asOf ? `?asOf=${encodeURIComponent(asOf.toISOString())}` : ''}`
  );

describe('availability from the ledger', () => {
  it('availability is recomputed from ledger rows inserted directly, without the cache', async () => {
    // A program whose cache columns say nothing (all zero), and a history written only to the ledger.
    const programId = `prg_ledger_${randomUUID().slice(0, 8)}`;
    await t.db.query(
      `INSERT INTO programs (id, name, currency, credit_limit_minor) VALUES ($1, 'ledger only', 'EUR', 0)`,
      [programId]
    );
    const rid = randomUUID();
    await t.db.query(
      `INSERT INTO reservations (id, program_id, invoice_ref, invoice_amount_minor, invoice_currency, amount_minor,
                                 fx_rate, fx_rate_at, fx_source, status)
       VALUES ($1, $2, 'INV-L', 70000, 'EUR', 70000, 1, now(), 'test', 'ACTIVE')`,
      [rid, programId]
    );
    await t.db.query(
      `INSERT INTO ledger_entries (program_id, kind, component, delta_minor, reservation_id, treasury_sequence, source) VALUES
         ($1, 'PROGRAM_OPENED',      'TREASURY_LIMIT',    1000000, NULL, NULL, 'audit-test'),
         ($1, 'TREASURY_ADJUSTMENT', 'TREASURY_UTILISED',  250000, NULL, 3,    'audit-test'),
         ($1, 'TREASURY_ADJUSTMENT', 'TREASURY_LIMIT',    -100000, NULL, 4,    'audit-test'),
         ($1, 'RESERVE',             'LOCAL',               70000, $2,   NULL, 'audit-test')`,
      [programId, rid]
    );

    // "Now" on the database's clock, at the precision timestamps are stored with.
    const { rows } = await t.db.query(
      'SELECT max(recorded_at) AS t FROM ledger_entries WHERE program_id = $1',
      [programId]
    );
    const res = await at(programId, rows[0].t);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      creditLimitMinor: '900000',
      treasuryUtilisedMinor: '250000',
      reservedMinor: '70000',
      availableMinor: '580000',
      treasurySequence: '4',
    });
    // The cache was never touched: the answer came from the ledger alone.
    expect((await at(programId)).body.availableMinor).toBe('0');
  });

  it('asOf returns the figures at a past instant', async () => {
    const programId = await t.program('EUR', 1_000_000n);
    const first = await t.reserve(programId, {
      invoiceRef: 'INV-7001',
      amountMinor: '100000',
      currency: 'EUR',
    });
    // The instant the API reported for the first reservation: an auditor's "as of when X was created".
    const t1 = new Date(first.body.createdAt);
    await new Promise((r) => setTimeout(r, 20));
    await t.reserve(programId, { invoiceRef: 'INV-7002', amountMinor: '200000', currency: 'EUR' });
    await deliver(t, snapshot(programId, 1, 2_000_000n, 0n));

    const past = await at(programId, t1);
    expect(past.body).toMatchObject({
      creditLimitMinor: '1000000',
      reservedMinor: '100000',
      availableMinor: '900000',
      asOf: t1.toISOString(),
    });
    expect((await at(programId)).body).toMatchObject({
      creditLimitMinor: '2000000',
      reservedMinor: '300000',
      asOf: null,
    });
    expect((await at(programId, new Date('2000-01-01T00:00:00Z'))).body.availableMinor).toBe('0'); // before it existed
  });

  it('after concurrent reserves, releases and treasury messages, the cache equals the ledger fold', async () => {
    const programId = await t.program('EUR', 10_000_000n);
    const made = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        t.reserve(programId, { invoiceRef: `INV-C${i}`, amountMinor: '100000', currency: 'EUR' })
      )
    );
    await Promise.all([
      ...made.slice(0, 6).map((r) => t.call('POST', `/reservations/${r.body.id}/release`)),
      deliver(t, snapshot(programId, 1, 9_000_000n, 500_000n)),
      deliver(t, snapshot(programId, 2, 8_000_000n, 1_000_000n)),
      ...Array.from({ length: 6 }, (_, i) =>
        t.reserve(programId, { invoiceRef: `INV-D${i}`, amountMinor: '50000', currency: 'EUR' })
      ),
    ]);
    const s = await dbState(t.db, programId);
    expect(s.ledgerLimit).toBe(s.limit);
    expect(s.ledgerTreasury).toBe(s.treasury);
    expect(s.ledgerReserved).toBe(s.reserved);
    const { rows } = await t.db.query(
      'SELECT max(recorded_at) AS t FROM ledger_entries WHERE program_id = $1',
      [programId]
    );
    expect((await at(programId, rows[0].t)).body).toEqual({
      ...(await at(programId)).body,
      asOf: expect.any(String),
    });
  });

  it('the database refuses UPDATE, DELETE and TRUNCATE on ledger rows (append-only)', async () => {
    const programId = await t.program('EUR', 1_000n);
    const mutate = ['UPDATE', 'ledger_entries SET delta_minor = 0 WHERE program_id = $1'].join(' ');
    const remove = ['DELETE FROM', 'ledger_entries WHERE program_id = $1'].join(' ');
    const wipe = ['TRUNCATE', 'ledger_entries CASCADE'].join(' ');
    await expect(t.db.query(mutate, [programId])).rejects.toThrow(/append-only/);
    await expect(t.db.query(remove, [programId])).rejects.toThrow(/append-only/);
    await expect(t.db.query(wipe)).rejects.toThrow(/append-only/);
    expect((await dbState(t.db, programId)).ledgerRows).toBeGreaterThan(0);
  });

  it('an asOf answer never changes later: it waits for a write in flight on the program', async () => {
    const programId = await t.program('EUR', 1_000_000n);
    // A writer holding the program row lock, as every ledger writer does, with a row written but not
    // yet committed.
    const writer = await t.db.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT 1 FROM programs WHERE id = $1 FOR UPDATE', [programId]);
      await writer.query(
        `INSERT INTO ledger_entries (program_id, kind, component, delta_minor, treasury_sequence, source)
         VALUES ($1, 'TREASURY_ADJUSTMENT', 'TREASURY_UTILISED', 300000, 1, 'in-flight')`,
        [programId]
      );
      const { rows } = await writer.query('SELECT clock_timestamp() AS now');
      const asOf = new Date(rows[0].now.getTime() + 1);
      await new Promise((r) => setTimeout(r, 5));

      const first = at(programId, asOf); // must wait for the writer, not answer without its row
      await new Promise((r) => setTimeout(r, 300));
      await writer.query('COMMIT');

      const answered = await first;
      expect(answered.status).toBe(200);
      expect(answered.body.treasuryUtilisedMinor).toBe('300000');
      expect((await at(programId, asOf)).body).toEqual(answered.body);
    } finally {
      writer.release();
    }
  });
});

describe('listing reservations', () => {
  it('pages through reservations created in the same millisecond without skipping any', async () => {
    const programId = await t.program('EUR', 10_000_000n);
    const made = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        t.reserve(programId, { invoiceRef: `INV-S${i}`, amountMinor: '100', currency: 'EUR' })
      )
    );
    // Force the worst case: every row in the same millisecond, so only the id breaks the tie.
    await t.db.query(
      "UPDATE reservations SET created_at = date_trunc('milliseconds', now()) WHERE program_id = $1",
      [programId]
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Res<{ items: { id: string }[]; nextCursor: string | null }> = await t.call(
        'GET',
        `/programs/${programId}/reservations?limit=1${cursor ? `&cursor=${cursor}` : ''}`
      );
      seen.push(...page.body.items.map((r: { id: string }) => r.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(made.map((r) => r.body.id).sort());
  });

  it('lists newest first, filters by status, and pages with a stable cursor', async () => {
    const programId = await t.program('EUR', 10_000_000n);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        (await t.reserve(programId, { invoiceRef: `INV-P${i}`, amountMinor: '1000', currency: 'EUR' })).body
          .id
      );
    }
    await t.call('POST', `/reservations/${ids[0]}/release`);

    const p1 = await t.call('GET', `/programs/${programId}/reservations?limit=2`);
    const p2 = await t.call(
      'GET',
      `/programs/${programId}/reservations?limit=2&cursor=${p1.body.nextCursor}`
    );
    // A new reservation arriving between pages does not shift the next page.
    await t.reserve(programId, { invoiceRef: 'INV-P-late', amountMinor: '1000', currency: 'EUR' });
    const p3 = await t.call(
      'GET',
      `/programs/${programId}/reservations?limit=2&cursor=${p2.body.nextCursor}`
    );

    const seen = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((r: { id: string }) => r.id);
    expect(seen).toEqual([...ids].reverse());
    expect(p3.body.nextCursor).toBeNull();
    const active = await t.call('GET', `/programs/${programId}/reservations?status=ACTIVE`);
    expect(active.body.items).toHaveLength(5); // 4 left of the first five + the late one
    expect(active.body.items.every((r: { status: string }) => r.status === 'ACTIVE')).toBe(true);
  });
});
