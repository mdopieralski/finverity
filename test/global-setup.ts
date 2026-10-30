// One real Postgres for the whole e2e run (Testcontainers). Each suite gets its own database in it
// (test/helpers/app.ts), so suites never see each other's rows.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

export const POSTGRES_IMAGE = 'postgres:17.10-alpine';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

export default async function setup({ provide }: TestProject): Promise<() => Promise<void>> {
  // max_connections is raised so the concurrency tests can hold one connection per in-flight request.
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withCommand(['postgres', '-c', 'max_connections=300'])
    .start();
  provide('pgAdminUrl', container.getConnectionUri());
  return async () => {
    await container?.stop();
  };
}
