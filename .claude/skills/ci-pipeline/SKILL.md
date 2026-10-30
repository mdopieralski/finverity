---
name: ci-pipeline
description: >-
  The GitHub Actions setup, modelled on the ingrid repo: one job per check in parallel (format, lint,
  typecheck, unit, e2e with Docker, compose smoke test, OpenAPI export + lint, commit messages, harness
  audits), a single aggregated "CI passed" check for branch protection, a shared setup action, SHA-pinned
  actions, JUnit artifacts, cancel superseded runs, and Dependabot with a cooldown. Use for .github/, "CI",
  "the pipeline", "required checks", "Dependabot", "why did CI fail?".
---

# CI pipeline

Owner: the `harness-engineer` agent. Model: `~/ingrid/.github/` (`workflows/ci.yml`, `actions/setup/`,
`dependabot.yml`). Every job is **one `pnpm` script**, so any failure reproduces locally with the same
command.

## `.github/workflows/ci.yml`

Triggers: `pull_request`, `push` to `main`, `workflow_dispatch`. `permissions: contents: read`.
`concurrency: ci-${{ github.ref }}`, `cancel-in-progress` except on `main`.

| Job               | Runs                                                                         | Notes                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Prettier`        | `pnpm run format`                                                            |                                                                                                                                  |
| `ESLint`          | `pnpm run lint`                                                              |                                                                                                                                  |
| `Typecheck`       | `pnpm run typecheck`                                                         |                                                                                                                                  |
| `Unit`            | `pnpm run test:ci` (unit, JUnit to `junit.xml`)                              | upload `junit-report` artifact, 14 days                                                                                          |
| `E2E`             | `pnpm run test:e2e:ci` (Testcontainers; Docker is on ubuntu runners)         | the seven graded specs + docs contract; JUnit artifact                                                                           |
| `Compose smoke`   | `docker compose up --build -d`, wait healthy, then the smoke script          | token → availability 200 → reserve 201 → replay same → `/openapi.json` 200 with token, 401 without → `/docs` 200 with Basic(JWT) |
| `OpenAPI`         | `pnpm run docs:check && pnpm run docs:lint`                                  | export is up to date; Redocly at a pinned version via `pnpm dlx`                                                                 |
| `Harness`         | `pnpm run test:tools && pnpm run audit:harness && pnpm run audit:invariants` |                                                                                                                                  |
| `Commit messages` | `pnpm exec commitlint --from $BASE_SHA --to $HEAD_SHA`                       | PRs only; `fetch-depth: 0`; skipped for Dependabot                                                                               |
| `CI passed`       | `if: always()`, `needs:` every job above; fails if any failed/cancelled      | **the one check to require** in the ruleset for `main`                                                                           |

`audit:submission` is not a CI job until the end (it fails by design while specs are missing); add it to
`needs` in the release PR (the `release-delivery` skill).

The compose smoke job lives in `scripts/ci-smoke.sh` (the `platform-engineer` agent's) so it runs the same
locally: `bash scripts/ci-smoke.sh`. On failure it prints `docker compose logs --tail 200`.

## Shared setup: `.github/actions/setup/action.yml`

Composite action: `pnpm/action-setup` (version from `packageManager`), `actions/setup-node` with
`node-version-file: .nvmrc` and `cache: pnpm`, `pnpm install --frozen-lockfile`.

## Rules (from ingrid)

- **Pin actions to commit SHAs** with a `# vX.Y.Z` comment. Look the SHAs up
  (`gh api repos/<owner>/<action>/git/ref/tags/<tag>`), never invent one.
- `timeout-minutes` on every job (5 for checks, 15 for e2e and compose).
- The commit-msg hook can be skipped locally; the `Commit messages` job cannot.
- No secrets needed: the JWT secret in CI is a dev value set in the workflow env.

## `.github/dependabot.yml`

Weekly, grouped (one PR for npm minor+patch, one for actions), `cooldown: default-days: 7`, commit prefix
`chore` / `ci` with scope (commitlint passes). Ignore `@types/node` majors (follows `.nvmrc`). Docker base
images: a third ecosystem `docker` for the `Dockerfile` and compose images.

## One-time GitHub setup (the user does this; say so in the README)

_Settings → Rules → Rulesets_: on `main` require a PR and the `CI passed` check, block force pushes. _Settings
→ General_: squash merge for work branches, auto-delete head branches. _Code security_: Dependabot version
updates on.

## Verify

`actionlint` if available (`pnpm dlx` is not an option for it: use the GitHub-hosted run), push the branch and
watch `gh run watch`; each job green, `CI passed` green. Report the run URL.
