import { defineConfig } from 'vitest/config';

// Unit tests: pure logic next to the code (src/**/*.spec.ts). No Docker.
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.spec.ts'],
  },
});
