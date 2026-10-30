---
name: add-feature
description: >-
  End-to-end workflow to build a piece of the capacity service: know where we are in the working order, plan
  with capacity-architect, write the graded spec and the code by owner agents in parallel, verify, review,
  fold decisions into the README. Holds the OWNERSHIP MAP (path → owner agent → skills). Use for "build X",
  "implement", "next step", "continue", or "who owns this path?".
---

# Add a feature

## 0. Know where we are

- Read `CLAUDE.md`. The session-start note says which graded specs exist and the next step in the **working
  order**: domain model and ledger → concurrency guard **with its test** → API with auth → idempotency → Kafka
  consumer → reconciliation → currency → README polish. Don't skip ahead: each step is the base of the next.
- First time in the repo (no `src/`): the `scaffold-service` skill, then `local-run` skill basics, then
  step 1.
- Open choices in CLAUDE.md not yet answered and needed now → ask the user before building on a guess.

## 1. Plan (capacity-architect)

Delegate to the `capacity-architect` agent with the step. It returns: the contract or schema change, the
transaction boundaries (what is in which transaction, lock order), files per owner, the spec cases with exact
test titles, risks, and the README entries the step produces. **If the plan touches more than three files or
changes a decided item in CLAUDE.md, show it to the user before code.**

## 2. Build (owners; spec and code in parallel)

### §2 Ownership map

One owner per path. Every agent's "what you own" points here. Implementing agents write colocated unit tests
(`src/**/*.spec.ts`) for their own code; `test/` belongs to the `test-engineer` agent.

| Path                                                                                                                                                                                                                                                 | Owner                                       | Skills it follows                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| `src/capacity/`, `src/money/`, `src/fx/`, `src/db/` (pool, transactions, migrate, seed), `migrations/`                                                                                                                                               | `ledger-engineer`                           | ledger-model, money-and-fx, scf-domain  |
| `src/http/`, `src/auth/`, `src/errors/`, `src/logging/`, `src/idempotency/`, `src/config/`, `src/docs/`, `src/main.ts`, `src/app.module.ts`, `scripts/mint-token.ts`, `scripts/export-openapi.ts`, `redocly.yaml`; generates `docs/api/openapi.json` | `api-engineer`                              | nestjs-service, idempotency, api-docs   |
| `src/treasury/`, `scripts/produce-treasury.ts`                                                                                                                                                                                                       | `messaging-engineer`                        | treasury-kafka, idempotency             |
| `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `package.json`, `tsconfig*.json`, `nest-cli.json`, `eslint.config.mjs`, `scripts/ci-smoke.sh`                                                                                   | `platform-engineer`                         | local-run, scaffold-service             |
| `test/` (graded specs, helpers, `global-setup.ts`)                                                                                                                                                                                                   | `test-engineer`                             | testing-strategy, scf-domain            |
| `README.md`, `docs/` (except decision records below and the generated `docs/api/openapi.json`)                                                                                                                                                       | `docs-engineer`                             | submission-readme, scf-domain, api-docs |
| `.claude/`, `tools/`, `.github/` (CI, setup action, Dependabot), `.husky/`, `CLAUDE.md`, `AGENTS.md`, `.prettierrc.json`, `.nvmrc`, `.gitignore`, commitlint, lint-staged                                                                            | `harness-engineer`                          | ai-harness, ci-pipeline                 |
| `docs/decisions/`                                                                                                                                                                                                                                    | the owner of the area the decision is about |                                         |

Read-only roles: the `capacity-architect` agent (plans) and the `code-reviewer` agent (diff review). They
report and never fix.

Shared seams:

- **Migrations** for `idempotency_keys` and `processed_messages`: the `ledger-engineer` agent writes them on
  request; the `api-engineer` and `messaging-engineer` agents may edit `migrations/` only with the user's OK
  (their allow-list asks).
- **Treasury SQL** (`applyTreasuryAdjustment`, `applyTreasurySnapshot`) lives in `src/capacity/` (ledger
  owner); the consumer (messaging owner) calls it inside its own transaction via `src/db/`'s
  `withTransaction`. Agree the function signature first.
- **`src/app.module.ts`**: the `api-engineer` agent wires modules; others say what to register.
- **`package.json`**: the `platform-engineer` agent; harness scripts are the `harness-engineer` agent's
  (asks).
- **Integration** (commit, PR) is done by the main session (the `ship-branch` skill); the user merges.
- If an agent is unavailable, follow its skills directly in the main session.

### Order inside a step

1. Contract first: types, function signatures, error kinds, test titles (from the plan).
2. **In parallel:** the `test-engineer` agent writes the spec against the contract (it fails: red), and the
   owner agent(s) build the code. Independent owners (e.g. ledger SQL and the controller) run as parallel
   agents against the agreed signature.
3. Wire up, run the spec: green. For the concurrency step, the `test-engineer` agent also proves the test goes
   red against a broken guard (testing-strategy skill).

## 3. Verify

The `verify-change` skill. For anything touching the write path, that means the e2e spec against a real
database, run more than once.

## 4. Review

The `code-reviewer` agent on the diff. Fix **blocking** findings, re-run the affected checks.

## 5. Close out

- Contract changed → `pnpm run docs:export` committed in the same PR, README API section updated (api-docs
  skill).

- The `docs-engineer` agent folds every agent's **Decisions taken** into the README (Behaviour decisions,
  Assumptions and trade-offs, Limitations) the same day (submission-readme skill).
- Report verified vs not verified. Ship with the `ship-branch` skill when the user wants it. After the last
  step: the `submission-check` skill, then the `release-delivery` skill.
