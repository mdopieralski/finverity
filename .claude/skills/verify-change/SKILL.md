---
name: verify-change
description: >-
  Prove a change works before calling it done: pick checks from what the diff touched (capacity/ledger,
  money/fx, http/auth/errors, idempotency, treasury, migrations, compose, tests, README, tools, .claude), run
  them fastest first, get a review, and report verified vs not verified. Use before committing or a PR, or for
  "does it work?", "run the checks", "test it".
---

# Verify a change

The rule: **say only what you ran.** A green unit test never proves the race; only parallel HTTP against
Postgres does. A passing test run on your machine never proves `docker compose up` from a clean clone.

## 1. What changed

```bash
git status --porcelain
git diff --stat main...HEAD        # plus uncommitted: git diff --stat
```

If the tree holds the user's unrelated work in progress, verify only your paths and say so.

## 2. Pick the checks (fastest first; stop at the first failure and fix it)

| Touched                                        | Run                                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/capacity/**`, reserve/release path        | typecheck, unit, `pnpm run test:e2e capacity.concurrency availability.ledger` (×3 runs)                                                        |
| `src/money/**`, `src/fx/**`                    | unit (`convertMinor` table incl. JPY), `test:e2e currency`                                                                                     |
| `src/http/**`, `src/errors/**`, `src/auth/**`  | `test:e2e auth validation`, and the curl for the changed endpoint against compose                                                              |
| `src/http/**`, `*.dto.ts`, `src/docs/**`       | `pnpm run docs:export && pnpm run docs:check && pnpm run docs:lint`, `test:e2e docs.contract auth`, open `/docs` and try the changed operation |
| `src/idempotency/**`                           | `test:e2e idempotency`                                                                                                                         |
| `src/treasury/**`                              | `test:e2e reconciliation idempotency`; produce a message with rpk and read the consumer log line                                               |
| `migrations/**`                                | fresh DB: `docker compose down -v && docker compose up --build` (asks first), then the full e2e suite                                          |
| `docker-compose.yml`, `Dockerfile`, seeds, env | the cold-start check in the `local-run` skill, then every README curl                                                                          |
| `test/**`                                      | the changed spec ×3; for a new guard test, prove it fails against a broken guard                                                               |
| `README.md`                                    | `pnpm run audit:submission` sections pass; run each changed command as written                                                                 |
| `.github/**`                                   | push the branch, `gh run watch`; every job and `CI passed` green (the `ci-pipeline` skill)                                                     |
| `tools/**`, `.claude/**`, `CLAUDE.md`          | `pnpm run test:tools && pnpm run audit:harness`; a sample payload through any changed hook                                                     |

Always: `pnpm run audit:invariants` (hard rules: no float money, no ledger mutation, no public routes, no
synchronize).

## 3. The full gate

Before pushing: `pnpm run ci:quality` and `pnpm run test:e2e`. Before calling the take-home done: the
`submission-check` skill.

## 4. Review

Run the `code-reviewer` agent on the diff. Fix **blocking** findings and re-run the affected checks.

## 5. Report

```
Verified:      ci:quality; test:e2e 41/41 (capacity.concurrency ×3, N=25, pool=30); audit:invariants clean
               compose cold start 74 s; README curls 1–5 as written
Not verified:  behaviour against real Apache Kafka (Redpanda only); load beyond N=25
Review:        code-reviewer: no blocking (1 should-fix fixed)
```

Never write "works" for a layer you did not exercise.
