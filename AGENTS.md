# Agents guide

Read `CLAUDE.md` first: it is the brief and the source of truth for this repo (graded invariants, decided
items, stack, layout, owners).

This is a NestJS + PostgreSQL + Kafka (Redpanda locally) backend take-home: program capacity and invoice
reservation for supply chain finance.

- Use pnpm only: `pnpm add <pkg>`, `pnpm exec <bin>`, `pnpm dlx <pkg>`. Ask before any dependency that is not
  Nest, the Postgres driver, the Kafka client or test tooling.
- Money is integer minor units (`bigint`, strings on the wire). The ledger is append-only. Every endpoint
  needs a JWT.
- Before declaring work done: `pnpm run ci:quality`, `pnpm run test:e2e`, and `docker compose up --build` with
  the README curls.
- Library APIs change: read the installed version and its docs, not memory.
