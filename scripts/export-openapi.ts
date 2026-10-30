// Writes docs/api/openapi.json from the @nestjs/swagger decorators, without a database or Kafka
// (the pool connects lazily and the consumer is off). CI runs `pnpm run docs:check` to fail on drift.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/create-app.js';
import { buildDocument } from '../src/docs/openapi.js';

const out = fileURLToPath(new URL('../../docs/api/openapi.json', import.meta.url));

const app = await createApp({
  port: 0,
  databaseUrl: 'postgres://unused@localhost:1/unused',
  dbPoolSize: 1,
  jwtSecret: 'export-only-not-a-secret',
  jwtIssuer: undefined,
  jwtAudience: undefined,
  kafkaEnabled: false,
  kafkaBrokers: [],
  kafkaTopic: 'treasury.capacity.v1',
  kafkaGroupId: 'export',
  apiDocs: false,
  fxRates: '',
});
const document = buildDocument(app);
await app.close();
mkdirSync(fileURLToPath(new URL('../../docs/api/', import.meta.url)), { recursive: true });
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${out} (${Object.keys(document.paths).length} paths, version ${document.info.version})`);
