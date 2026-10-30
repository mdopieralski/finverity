---
name: scaffold-service
description: >-
  First-time scaffold of the NestJS service into this repo: generate with the Nest CLI via pnpm dlx into a
  scratch folder and merge (the root package.json and harness already exist), TypeScript strict, Vitest for
  unit and e2e, Prettier/ESLint, scripts the harness expects (ci:quality, test:e2e, token, produce, migrate),
  and the folder layout. Use once at the start, or for "scaffold", "set up the project", "add the scripts".
---

# Scaffold the service

Owner: the `platform-engineer` agent (configs, package.json, Dockerfile), with the `harness-engineer` agent
for the harness scripts. Do this once; afterwards each folder has its owner (add-feature skill §2).

> **Done (2026-10-28).** The service was scaffolded by hand rather than with the CLI: Nest 12 is ESM-only
> (`"type": "module"`, Vitest), see `docs/decisions/stack-2026-10-28.md`. Kept as the reference for what the
> scripts and configs are for.

## 1. Check before generating

- `node -v` (22.x), `pnpm -v` (matches `packageManager`).
- Look up the **current** `@nestjs/cli` major and its `new` flags: `pnpm dlx @nestjs/cli@latest --version`,
  `pnpm dlx @nestjs/cli@latest new --help`. Don't trust remembered flags.

## 2. Generate aside, then merge

The repo root already holds `package.json`, `.claude/`, `tools/`, `CLAUDE.md`, so generate into the
scratchpad:

```bash
pnpm dlx @nestjs/cli@latest new program-capacity --package-manager pnpm --skip-git --strict --directory <scratchpad>/nest
```

Move `src/`, `test/`, `tsconfig*.json`, `nest-cli.json`, `eslint.config.mjs` into the repo. **Merge**
`package.json`: keep our `name`, `engines`, `packageManager` and harness scripts; add Nest's dependencies and
scripts. Then `pnpm install`. Delete the sample `app.controller`/`app.service` (they would be public routes).

## 3. Settings

- `tsconfig.json`: `"strict": true`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `target` ES2023 (bigint
  literals), `useUnknownInCatchVariables`.
- BigInt JSON: never rely on `BigInt.prototype.toJSON` monkey-patching; map amounts to strings in DTO mappers.
- Prettier: the repo's `.prettierrc.json`. ESLint: Nest's default flat config plus
  `@typescript-eslint/no-floating-promises`.

## 4. Scripts the harness and README expect

```jsonc
"build": "nest build",
"start": "node dist/main.js",
"start:dev": "nest start --watch",
"migrate": "node dist/db/migrate.js",              // or ts-node in dev; plain SQL files in migrations/
"seed": "node dist/db/seed.js",
"token": "node dist/scripts/mint-token.js",         // prints only the token (works with `pnpm run -s token`)
"produce": "node dist/scripts/produce-treasury.js",
"typecheck": "tsc --noEmit",
"lint": "eslint .",
"format": "prettier --check .",
"test": "vitest run",                               // unit, src/**/*.spec.ts
"test:e2e": "vitest run --config vitest.config.e2e.ts",
"test:ci": "vitest run --reporter=default --reporter=junit --outputFile.junit=junit.xml",
"test:e2e:ci": "vitest run --config vitest.config.e2e.ts --reporter=default --reporter=junit --outputFile.junit=junit-e2e.xml",
"docs:export": "node dist/scripts/export-openapi.js",         // writes docs/api/openapi.json (api-docs skill)
"docs:check": "pnpm run docs:export && git diff --exit-code docs/api/openapi.json",
"docs:lint": "pnpm --package=@redocly/cli@<pinned> dlx redocly lint docs/api/openapi.json",
"ci:quality": "pnpm run format && pnpm run lint && pnpm run typecheck && pnpm test && pnpm run docs:check && pnpm run test:tools && pnpm run audit:harness && pnpm run audit:invariants"
```

`test:e2e` is not in `ci:quality` locally because it needs Docker; CI runs it separately.

## 5. Dependencies: allowed vs ask first

Allowed without asking (CLAUDE.md): `@nestjs/*` (incl. `@nestjs/swagger`, decided for the docs), the Postgres
driver, the Kafka client, test tooling (vitest, testcontainers, ajv). **Ask first** for anything else
(validation library, logger, migration tool, uuid helper: `crypto.randomUUID()` already exists; husky +
commitlint + lint-staged for the ingrid-style git hooks). Record the answers in `docs/decisions/`.

## 6. Docs, CI, hooks (ingrid's delivery kit)

- `@nestjs/swagger` set up per the `api-docs` skill on the skeleton, `docs/api/openapi.json` exported.
- The `harness-engineer` agent adds `.github/` per the `ci-pipeline` skill once a remote exists.
- If the user approves husky/commitlint/lint-staged: `commit-msg` → commitlint, `pre-commit` → lint-staged
  (Prettier + `eslint --fix`), `pre-push` → `format`, `lint`, `typecheck`.

## 7. Done when

`pnpm run ci:quality` is green on the empty skeleton, `docker compose up --build` starts it (local-run skill),
and the session-start note shows the next working-order step.
