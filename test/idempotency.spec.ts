// Invariant 2: idempotency. HTTP retries (Idempotency-Key) and Kafka redeliveries (processed_messages)
// take effect once. The Kafka test goes through a real Redpanda broker and the real consumer.
import { randomUUID } from 'node:crypto';

import { RedpandaContainer, type StartedRedpandaContainer } from '@testcontainers/redpanda';
import { Kafka, logLevel } from 'kafkajs';

import { dbState, deliver, snapshot, startApp, type TestApp } from './helpers/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(() => t.close());

const body = { invoiceRef: 'INV-2001', amountMinor: '250000', currency: 'EUR' };

describe('HTTP: Idempotency-Key', () => {
  it('one invoice cannot be reserved twice, even with different keys and in parallel', async () => {
    const programId = await t.program('EUR', 10_000_000n);
    const invoice = { invoiceRef: `INV-${randomUUID()}`, amountMinor: '100000', currency: 'EUR' };
    const results = await Promise.all(Array.from({ length: 8 }, () => t.reserve(programId, invoice)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.body.error.code).toBe('invoice_already_reserved');
    }
    const state = await dbState(t.db, programId);
    expect(state.reserved).toBe(100_000n); // the refused ones gave their increment back

    // Once released, the invoice can be reserved again (e.g. a re-approval after repayment).
    const created = results.find((r) => r.status === 201)!;
    expect((await t.call('POST', `/reservations/${created.body.id}/release`)).status).toBe(200);
    expect((await t.reserve(programId, invoice)).status).toBe(201);
  });

  it('a refused duplicate invoice is stored under its key and replayed', async () => {
    const programId = await t.program('EUR', 10_000_000n);
    const invoice = { invoiceRef: `INV-${randomUUID()}`, amountMinor: '100000', currency: 'EUR' };
    expect((await t.reserve(programId, invoice)).status).toBe(201);
    const key = `approval-${randomUUID()}`;
    const first = await t.reserve(programId, invoice, key);
    const replay = await t.reserve(programId, invoice, key);
    expect([first.status, replay.status]).toEqual([409, 409]);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });

  it('the same Idempotency-Key returns the original result', async () => {
    const programId = await t.program('EUR', 10_000_000n);
    const key = `approval-${randomUUID()}`;

    const first = await t.reserve(programId, body, key);
    // Same request, keys in a different order: still the same request.
    const replay = await t.reserve(
      programId,
      { currency: 'EUR', amountMinor: '250000', invoiceRef: 'INV-2001' },
      key
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    const s = await dbState(t.db, programId);
    expect(s.reservations).toBe(1);
    expect(s.reserved).toBe(250_000n);
    expect(s.ledgerRows).toBe(2); // PROGRAM_OPENED + one RESERVE
  });

  it('the same key with a different body is 409 and writes nothing', async () => {
    const programId = await t.program('EUR', 10_000_000n);
    const key = randomUUID();
    await t.reserve(programId, body, key);
    const before = await dbState(t.db, programId);

    const res = await t.reserve(programId, { ...body, amountMinor: '250001' }, key);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'idempotency_key_reused',
      message: 'Idempotency-Key was already used with a different request.',
    });
    expect(await dbState(t.db, programId)).toEqual(before);
  });

  it('parallel requests with one key create exactly one reservation and identical responses', async () => {
    const programId = await t.program('EUR', 10_000_000n);
    const key = randomUUID();

    const results = await Promise.all(Array.from({ length: 15 }, () => t.reserve(programId, body, key)));

    expect(new Set(results.map((r) => r.status))).toEqual(new Set([201]));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(14);
    expect((await dbState(t.db, programId)).reservations).toBe(1);
  });

  it('a rejected request is replayed as rejected, even after capacity frees up (a retry never pays twice)', async () => {
    const programId = await t.program('EUR', 100_000n);
    const key = randomUUID();
    const big = { ...body, amountMinor: '150000' };

    expect((await t.reserve(programId, big, key)).status).toBe(422);
    await deliver(t, snapshot(programId, 1, 10_000_000n, 0n)); // treasury raises the limit
    const replay = await t.reserve(programId, big, key);

    expect(replay.status).toBe(422);
    expect(replay.body.error.code).toBe('insufficient_capacity');
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect((await dbState(t.db, programId)).reservations).toBe(0);
    // A new key is a new request, and now fits.
    expect((await t.reserve(programId, big, randomUUID())).status).toBe(201);
  });

  it('keys are scoped to the token subject: two clients may use the same key', async () => {
    const programId = await t.program('EUR', 10_000_000n);
    const key = 'shared-key';
    // Different invoices: one invoice has at most one ACTIVE reservation, whoever asks.
    const a = await t.reserve(programId, { ...body, invoiceRef: 'INV-2001-A' }, key, t.token('client-a'));
    const b = await t.reserve(programId, { ...body, invoiceRef: 'INV-2001-B' }, key, t.token('client-b'));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('releasing twice releases once and returns the original release', async () => {
    const programId = await t.program('EUR', 10_000_000n);
    const { body: r } = await t.reserve(programId, body);

    const [one, two] = await Promise.all([
      t.call('POST', `/reservations/${r.id}/release`),
      t.call('POST', `/reservations/${r.id}/release`),
    ]);

    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.body).toEqual(two.body);
    expect(one.body.status).toBe('RELEASED');
    const s = await dbState(t.db, programId);
    expect(s.reserved).toBe(0n);
    expect(s.ledgerRows).toBe(3); // opened, reserve, ONE release
  });
});

describe('Kafka: consumer-side dedup', () => {
  it('a redelivered message is recognised as a duplicate, not merely as stale', async () => {
    const programId = await t.program('EUR', 1_000_000n);
    const msg = snapshot(programId, 1, 2_000_000n, 0n);

    expect(await deliver(t, msg)).toBe('applied');
    expect(await deliver(t, msg)).toBe('duplicate');

    const { rows } = await t.db.query('SELECT outcome FROM processed_messages WHERE message_id = $1', [
      msg.messageId,
    ]);
    expect(rows).toEqual([{ outcome: 'applied' }]);
  });

  describe('through a real broker', () => {
    let redpanda: StartedRedpandaContainer;
    let k: TestApp;

    beforeAll(async () => {
      redpanda = await new RedpandaContainer('docker.redpanda.com/redpandadata/redpanda:v26.1.19').start();
      k = await startApp({
        kafkaEnabled: true,
        kafkaBrokers: [redpanda.getBootstrapServers()],
        kafkaTopic: `treasury-${randomUUID()}`,
      });
    }, 180_000);
    afterAll(async () => {
      await k?.close();
      await redpanda?.stop();
    });

    it('the same Kafka message is applied once', async () => {
      const programId = await k.program('EUR', 1_000_000n);
      const reserved = await k.reserve(programId, { ...body, amountMinor: '100000' });
      expect(reserved.status).toBe(201);
      const message = {
        messageId: `tre-${randomUUID()}`,
        type: 'ADJUSTMENT',
        programId,
        treasurySequence: '1',
        currency: 'EUR',
        component: 'UTILISED',
        deltaMinor: '300000',
      };

      const { kafkaTopic: topic, kafkaGroupId: groupId } = k.config;
      const kafka = new Kafka({ brokers: [redpanda.getBootstrapServers()], logLevel: logLevel.NOTHING });
      const producer = kafka.producer();
      await producer.connect();
      const send = () =>
        producer.send({ topic, messages: [{ key: programId, value: JSON.stringify(message) }] });
      await send();
      await send(); // the broker delivers it twice: at-least-once
      await producer.disconnect();

      // Poll until the consumer has committed past both deliveries (no sleep-and-hope).
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && (await committedOffsets(kafka, groupId, topic)) < 2) {
        await new Promise((r) => setTimeout(r, 200));
      }

      const { rows } = await k.db.query('SELECT outcome FROM processed_messages WHERE message_id = $1', [
        message.messageId,
      ]);
      expect(rows).toEqual([{ outcome: 'applied' }]);
      const s = await dbState(k.db, programId);
      expect(s.treasury).toBe(300_000n); // applied once, not 600,000
      expect(s.reserved).toBe(100_000n); // the local reservation is untouched
      expect(await committedOffsets(kafka, groupId, topic)).toBe(2); // both deliveries acknowledged
    });

    it('a message whose handling fails is not acknowledged, and is applied exactly once on redelivery', async () => {
      const programId = await k.program('EUR', 1_000_000n);
      const { kafkaTopic: topic, kafkaGroupId: groupId } = k.config;
      const kafka = new Kafka({ brokers: [redpanda.getBootstrapServers()], logLevel: logLevel.NOTHING });
      const before = await committedOffsets(kafka, groupId, topic);

      // The first attempt fails as if the database dropped mid-transaction; later attempts are real.
      const handler = k.treasury;
      const real = handler.handle.bind(handler);
      let attempts = 0;
      let committedWhenRetried: number | undefined;
      handler.handle = async (...args) => {
        attempts++;
        if (attempts === 1) {
          throw Object.assign(new Error('connection terminated'), { code: '57P01' });
        }
        committedWhenRetried ??= await committedOffsets(kafka, groupId, topic);
        return real(...args);
      };
      try {
        const message = {
          messageId: `tre-${randomUUID()}`,
          type: 'ADJUSTMENT',
          programId,
          treasurySequence: '1',
          currency: 'EUR',
          component: 'UTILISED',
          deltaMinor: '1000',
        };
        const producer = kafka.producer();
        await producer.connect();
        await producer.send({ topic, messages: [{ key: programId, value: JSON.stringify(message) }] });
        await producer.disconnect();

        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline && (await committedOffsets(kafka, groupId, topic)) < before + 1) {
          await new Promise((r) => setTimeout(r, 250));
        }

        expect(attempts).toBeGreaterThanOrEqual(2);
        expect(committedWhenRetried).toBe(before); // the failed attempt committed nothing
        expect(await committedOffsets(kafka, groupId, topic)).toBe(before + 1);
        const { rows } = await k.db.query('SELECT outcome FROM processed_messages WHERE message_id = $1', [
          message.messageId,
        ]);
        expect(rows).toEqual([{ outcome: 'applied' }]);
        expect((await dbState(k.db, programId)).treasury).toBe(1000n);
      } finally {
        handler.handle = real;
      }
    }, 90_000);
  });
});

/** Sum of the consumer group's committed offsets over the topic's partitions. */
async function committedOffsets(kafka: Kafka, groupId: string, topic: string): Promise<number> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const [res] = await admin.fetchOffsets({ groupId, topics: [topic] });
    return (res?.partitions ?? []).reduce((sum, p) => sum + Math.max(0, Number(p.offset)), 0);
  } finally {
    await admin.disconnect();
  }
}
