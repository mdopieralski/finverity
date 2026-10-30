// Sends a treasury message to Kafka, as the treasury system would.
//   pnpm run produce -- snapshot   <programId> --seq N --limit <minor> --utilised <minor> [--currency EUR] [--id <messageId>]
//   pnpm run produce -- adjustment <programId> --seq N --component LIMIT|UTILISED --delta <±minor> [--currency EUR] [--id …]
// Repeat a message (same --id) to see it deduplicated; send a lower --seq to see it discarded as stale.
import { randomUUID } from 'node:crypto';

import { Kafka, logLevel } from 'kafkajs';

const [type, programId] = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== '--');
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const CURRENCIES: Record<string, string> = {
  prg_eur_acme: 'EUR',
  prg_usd_globex: 'USD',
  prg_jpy_umbrella: 'JPY',
};

if ((type !== 'snapshot' && type !== 'adjustment') || !programId || !flag('seq')) {
  console.error(
    'usage: produce snapshot|adjustment <programId> --seq N … (see the header of scripts/produce-treasury.ts)'
  );
  process.exit(2);
}

const message = {
  messageId: flag('id') ?? `tre-${randomUUID()}`,
  type: type.toUpperCase(),
  programId,
  treasurySequence: flag('seq'),
  currency: flag('currency') ?? CURRENCIES[programId] ?? 'EUR',
  ...(type === 'snapshot'
    ? {
        asOf: new Date().toISOString(),
        creditLimitMinor: flag('limit'),
        treasuryUtilisedMinor: flag('utilised') ?? '0',
      }
    : {
        occurredAt: new Date().toISOString(),
        component: flag('component') ?? 'UTILISED',
        deltaMinor: flag('delta'),
      }),
};

const kafka = new Kafka({
  clientId: 'treasury-simulator',
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(','),
  logLevel: logLevel.ERROR,
});
const producer = kafka.producer();
await producer.connect();
await producer.send({
  topic: process.env.KAFKA_TOPIC ?? 'treasury.capacity.v1',
  messages: [{ key: programId, value: JSON.stringify(message) }],
});
await producer.disconnect();
console.log(JSON.stringify(message));
