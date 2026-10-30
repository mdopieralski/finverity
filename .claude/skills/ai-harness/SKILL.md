---
name: ai-harness
description: >-
  How this repo's Claude Code harness works and how to change it safely: .claude agents, skills, hooks and
  settings; rule logic in tools/harness/hook-rules.mjs with tests; the harness and invariants audits; adding
  an agent or skill; hook design rules. Use when editing anything in .claude/, tools/, CLAUDE.md, or for "add
  an agent", "new skill", "the hook blocked me", "why was this denied?".
---

# AI harness

Owner: the `harness-engineer` agent. Same standard as the city-turfer (turf-track) and mObywatel repos: thin
hooks, pure tested rules, least-privilege agents, an ownership map.

## Layout

| Path                             | What                                                                                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                      | the brief (decided items, graded invariants) + layout, team, commands. Source of truth                                                                                                         |
| `AGENTS.md`                      | pointer for other agent tools                                                                                                                                                                  |
| `.claude/settings.json`          | permission allow/deny lists, hook wiring                                                                                                                                                       |
| `.claude/agents/<name>.md`       | one specialist each: frontmatter (`name`, `description`, `tools`, `model`, `color`, `hooks`) + prompt                                                                                          |
| `.claude/skills/<name>/SKILL.md` | procedures and knowledge, loaded on demand                                                                                                                                                     |
| `.claude/hooks/*.mjs`            | thin I/O wrappers                                                                                                                                                                              |
| `tools/harness/hook-rules.mjs`   | **all rule logic**, pure functions                                                                                                                                                             |
| `tools/harness/git-context.mjs`  | branch / dirty / committed-file facts for hooks                                                                                                                                                |
| `tools/harness/frontmatter.mjs`  | tiny frontmatter reader for the audit                                                                                                                                                          |
| `tools/harness-audit.mjs`        | `pnpm run audit:harness`                                                                                                                                                                       |
| `tools/invariants-audit.mjs`     | `pnpm run audit:invariants` (hard rules) and `audit:submission` (`--strict`: the gate, incl. the exported spec's four secured operations and README tables vs `package.json` / `.env.example`) |
| `tools/__tests__/*.test.mjs`     | `pnpm run test:tools` (`node --test`)                                                                                                                                                          |

## Hooks

| Hook                 | Event / matcher                  | Effect                                                                                                                                                                                                                     |
| -------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-start.mjs`  | SessionStart                     | branch, dirty tree, graded specs present, next working-order step, the four invariants                                                                                                                                     |
| `pre-edit.mjs`       | PreToolUse Edit/Write/MultiEdit  | **deny**: lockfile, `.env`, build output, the generated `docs/api/openapi.json`; editing a committed migration; `synchronize: true`; UPDATE/DELETE/TRUNCATE on `ledger_entries` in src/migrations; public-route decorators |
| `pre-bash.mjs`       | PreToolUse Bash                  | **deny**: npm/npx/yarn, no-verify, force-push, push to main; **ask**: `gh pr merge`, public repo, `docker compose down -v` / volume rm                                                                                     |
| `post-edit.mjs`      | PostToolUse Edit/Write/MultiEdit | Prettier; **block** new `amount…: number`, `parseFloat`/`toFixed`/`Math.round` in src, float column types in migrations; one-off invariant reminders                                                                       |
| `read-only-bash.mjs` | agent frontmatter                | read-only Bash for reviewers and planners (no file, git, DB or container writes)                                                                                                                                           |
| `edit-allowlist.mjs` | agent frontmatter                | per-agent edit scope (`--allow`, `--ask`)                                                                                                                                                                                  |

### Design rules

1. **Pure rules + thin I/O.** Logic in `hook-rules.mjs`, unit-tested. Hooks parse stdin, call a rule, print.
2. **Right strength.** `deny` for what must never happen; `ask` for what the user may want; PostToolUse
   `block` for "fix before moving on"; plain context for reminders.
3. **Fast prefilter.** Bash hooks bail out unless the command mentions a guarded tool.
4. **Never break on missing input.** No payload, no git, outside the repo: exit 0 silently.
5. **Explain the way out.** Every message says what to do instead and names the skill.
6. Rule sources (`tools/`, `.claude/`, `docs/`, `CLAUDE.md`, `AGENTS.md`, `README.md`) are exempt from content
   rules (`isRuleSource`), because they must name what they forbid.
7. Money rules fire only on **newly added** occurrences, so one legacy line never blocks unrelated edits.

### Known false positives

- `pre-bash.mjs` scans the whole command text, heredocs included. Write files with the Write tool; in tests,
  build risky strings from parts.
- `money-bigint` keys on names (`amount`, `minor`, `creditLimit`, `reserved`, `available`, `balance`,
  `utilised`, `capacity`). A non-money field with such a name: rename it (e.g. `pageSize`, not `limit` —
  pagination `limit` itself is not matched). If a rename is wrong, fix the rule with a test.

## Adding or changing an agent

1. `.claude/agents/<name>.md`, `name` equals the file name. The `description` says when to use it, with
   trigger phrases (the router reads only this).
2. Least privilege. Reviewers and planners: no Edit/Write, the `read-only-bash.mjs` hook. Writers:
   `edit-allowlist.mjs` with their paths (`--allow`) and shared seams (`--ask`).
3. Add its paths to the ownership map in the `add-feature` skill and the team table in `CLAUDE.md`.
4. Reference agents and skills as the name in backticks followed by the word agent or skill; the audit checks
   them.
5. Body sections as in the others: role, what you own / hand off, read first, how you work, what good looks
   like, non-negotiables, before you report back, report.

## Adding or changing a skill

`.claude/skills/<name>/SKILL.md`, `name` equals the folder, description = what **and** when. Concrete and
repo-specific. Link it from the agents that follow it and the ownership map.

## Changing a rule

1. Edit `tools/harness/hook-rules.mjs`, add the block **and** the allow case to
   `tools/__tests__/hook-rules.test.mjs`.
2. `pnpm run test:tools && pnpm run audit:harness && pnpm run audit:invariants`.
3. Try it by hand:
   `echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | node .claude/hooks/pre-bash.mjs`.

## Verify

The commands above, then a new session (or `/agents`): new agents and skills must appear in the lists.
