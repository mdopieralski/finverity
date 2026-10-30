---
name: submission-readme
description: >-
  How the README for this take-home is written, modelled on the ingrid repo's README: a centred header with
  the job in one line, badges and section links, a curl-and-response proof above the fold, then the six
  required sections in order (Quick start → API → How it works → Behaviour decisions → Assumptions and
  trade-offs → Limitations and next steps) with Testing, Development and CI in between, tables kept in sync
  with package.json and .env.example by the audit, and every command run as written. Use when editing
  README.md or docs/decisions/, or for "update the README", "document this decision", "write the trade-offs".
---

# Submission README

Owner: the `docs-engineer` agent. Model: `~/ingrid/README.md` (read it before a big change). The
`readme-design` skill (global) covers first-screen craft; where they differ, the required order in CLAUDE.md
wins. `pnpm run audit:submission` checks the order, the required sentences, and that the Scripts and
Environment tables match `package.json` and `.env.example`.

## Skeleton

```markdown
<div align="center">

# program-capacity

**Real-time credit capacity for supply chain finance programs: reserve on early payment, release on
repayment.**

One line on what it guarantees: never oversubscribed, safe to retry, treasury snapshots can't roll it back.

[![CI](…/actions/workflows/ci.yml/badge.svg)](…) ![Node 26] ![TypeScript strict] ![NestJS 11] ![PostgreSQL 18]
![OpenAPI 3.x]

[Quick start](#quick-start) · [API](#api) · [How it works](#how-it-works) ·
[Behaviour decisions](#behaviour-decisions) · [Testing](#testing)

</div>

​`sh            ← proof artifact: one real reserve call and its real response, copied from a run curl -s -X POST localhost:3000/programs/prg_eur_acme/reservations -H "Authorization: Bearer $TOKEN" \   -H "Idempotency-Key: inv-1001" -H 'Content-Type: application/json' \   -d '{"invoiceRef":"INV-1001","amountMinor":"1250000","currency":"USD"}' ​`
​`json { "id": "…", "programId": "prg_eur_acme", "amountMinor": "1136364", "currency": "EUR", "fxRate": "0.909091", … } ​`
One sentence: amounts are integer minor units as strings; USD 12,500.00 reserved EUR 11,363.64 at the stored
rate.

---

## Contents (numbered list linking every ## below)

## Quick start

## API

## How it works

## Behaviour decisions

## Assumptions and trade-offs

## Testing

## Development

## Limitations and next steps

## License
```

The six required sections keep their relative order; Testing and Development sit between "Assumptions and
trade-offs" and "Limitations and next steps" (the audit checks relative order only).

## What each section holds

**Quick start**: "You need: Docker" (and optionally Node 26 + pnpm). `docker compose up --build`. A "What /
Where" table: API `http://localhost:3000`, Swagger UI `/docs`, OpenAPI `/openapi.json`, Redpanda Console if
any. How to get a token (host and in-container). A **Try it** block: commented curls each followed by `#
<status>
<body>` copied from a real run: availability, reserve, replay (same response), different body (409), one unit
too many (422), release, availability back to start, a treasury snapshot via `pnpm run produce`, an older
snapshot (ignored). How to open `/docs`: the browser asks for a password, paste the token, then
_Authorize_ is already set for _Try it out_. "Something stuck?" full reset line.

**API**: a Method / Path / Purpose table (the four endpoints + `/docs` + `/openapi.json`, marked as docs, also
behind the JWT). The sentence ingrid uses: the spec is checked against the code by
`test/docs.contract.spec.ts`; if the docs drift, CI fails. Link `docs/api/openapi.json`. Per endpoint:
parameters table, request and response JSON, notes. Then **Money format** (strings of minor units, exponents
table incl. JPY), **Idempotency** (header, replay, 409, release idempotent by state), **Errors** (the error
table: status, code, constant message, when), `X-Request-Id`, pagination, `asOf`. Use GitHub callouts
(`> [!IMPORTANT]`) sparingly for traps (amounts are strings; `asOf` needs an offset).

**How it works**: one Mermaid `sequenceDiagram` (ingrid style) or flowchart showing both writers into one
ledger: HTTP reserve (guard → tx: idempotency row, conditional UPDATE, reservation, ledger row → commit) and
Kafka (consumer → tx: processed_messages, sequence check, rebase deltas → commit → offset commit). Then a
short **Data model** table (programs = cache, reservations, ledger_entries = truth, idempotency_keys,
processed_messages) and a **Limits** table (pool size, page size, key length, …) with "Why" per row.

**Behaviour decisions**: one bullet per decision, bold lead, "what we do → why", and **the test that proves
it** in backticks. The graded four first: conditional UPDATE vs `FOR UPDATE` (no optimistic locking);
idempotency incl. replayed rejections and 409; consumer-side exactly-once (the required sentence);
strictly-greater sequence, equal is stale; snapshot rebases only the treasury component; convert once, round
up, store rate + time, release exact. Then: 422 for insufficient capacity, amounts as strings, docs behind the
JWT, logs (fields, one line per request, never tokens or bodies).

**Assumptions and trade-offs**: Redpanda instead of Kafka (the required reasoning); NestJS (or the Fastify
fallback); snapshot utilisation excludes local reservations; one sequence for adjustments and snapshots; limit
cut below utilisation applied; FX fixing policy (the required sentence); driver/validation/client choices;
Testcontainers vs compose DB; JWT HS256 shared secret; spec from decorators (and what that costs).

**Testing**: commands (`pnpm test`, `pnpm run test:e2e`, time each takes, needs Docker). The ingrid table:
File / Proves, one row per spec file, the five must-haves named. How concurrency is made real (N, pool size,
"proved red against a broken guard"). The contract test sentence.

**Development**: Stack table (with links), Project structure tree with one-line comments (ingrid style),
**Environment** table (Variable / Default / Notes, must match `.env.example`), **Scripts** table (Name / What
it does, must match `package.json`; `a` / `b` pairs allowed in one cell), Git hooks, **CI** table (Job / Runs
/ Notes, ending with `CI passed` as the one required check; the `ci-pipeline` skill), Claude Code harness (one
paragraph pointing to `CLAUDE.md` and `.claude/`).

**Limitations and next steps**: the out-of-scope list from CLAUDE.md, each as a bold lead + what is missing +
"In production: …" (ingrid style): no UI; no real FX service; no multi-tenancy/roles; no ledger retention or
archiving; no metrics exporter (the log fields that would feed it); no Kubernetes; plus DLQ topic,
idempotency-key TTL, outbox for downstream events, docs published from CI instead of served, load not
measured.

## Sentences that must appear (meaning intact)

- _The broker guarantees at-least-once, so exactly-once is achieved by consumer-side dedup, not by the
  broker._
- _Production would use a rate service with a defined fixing policy; fixing policy is a business decision, not
  an engineering one._
- Why Redpanda; why the conditional UPDATE (or `FOR UPDATE`).

## Writing it as we go

- Every agent's report has **Decisions taken**; the `docs-engineer` agent folds them into Behaviour decisions,
  Assumptions or Limitations the same day (add-feature close-out).
- A longer decision gets `docs/decisions/<topic>-YYYY-MM-DD.md` and a one-line README entry linking it.
- **A documented omission is a senior signal; a silent one is a gap.**

## Style

Plain and specific: numbers, commands, tables. Domain words from the scf-domain skill. No emoji in headings.
Every command and every `# 200 {…}` line comes from a real run, copied, never typed from memory.
