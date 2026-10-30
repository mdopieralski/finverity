import { defineConfig } from 'vitest/config';

// The graded specs: the real app over real HTTP against a real Postgres (and Redpanda for the Kafka
// tests), started once by Testcontainers in test/global-setup.ts. Files run one at a time so they don't
// compete for the containers; tests inside a file still fire requests in parallel where that is the point.
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: { LOG_SILENT: '1' },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
