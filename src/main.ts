import { loadConfig } from './config/config.js';
import { createApp } from './create-app.js';
import { createPool } from './db/database.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { log } from './logging/logger.js';

const config = loadConfig();

// Migrations (and the optional demo seed) run before the service accepts traffic.
const pool = createPool(config.databaseUrl, 1);
const applied = await migrate(pool);
const seeded = process.env.SEED_DEMO_DATA === 'true' ? await seed(pool) : [];
await pool.end();
log('info', 'database ready', { migrationsApplied: applied, programsSeeded: seeded });

const app = await createApp(config);
await app.listen(config.port, '0.0.0.0');
// Set by Portless under `pnpm start:dev` (https://finverity.local); plain localhost otherwise.
const url = process.env.PORTLESS_URL || `http://localhost:${config.port}`;
log('info', 'listening', {
  url,
  port: config.port,
  docs: config.apiDocs ? `${url}/docs` : 'off',
  kafka: config.kafkaEnabled,
});
