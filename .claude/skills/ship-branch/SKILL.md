---
name: ship-branch
description: >-
  Commit, push and open a PR the way this repo does it: feat/fix/docs/chore branch from main, explicit paths,
  Conventional Commits with scope = area, PR into main with an honest test plan, never merge. Covers the
  not-yet-a-git-repo case. Use for "commit", "push", "open a PR", "ship it", "cut a branch".
---

# Ship a branch

The `.claude/hooks/pre-bash.mjs` guard denies pushing to `main`, force-push, skipping hooks with the no-verify
flag, and npm/npx/yarn. It asks before `gh pr merge`, a public `gh repo create`, and wiping Docker volumes.

## 0. Where am I?

```bash
git rev-parse --is-inside-work-tree 2>/dev/null || echo "not a repo"
git branch --show-current; git status --porcelain; git remote -v
```

- **Not a repo:** ask the user before `git init -b main`. First commit on `main` is the harness + scaffold
  (`chore(claude): …`); later work goes on branches.
- **No remote:** ask the user to create the GitHub repository (private by default for a take-home) or to
  confirm `gh repo create <name> --private --source .`. Never create a public repo on your own.

## 1. Cut a branch from main

```bash
git switch -c feat/<area>         # or fix/<area>, docs/<topic>, chore/<topic>
```

Areas (commit scopes): `ledger`, `capacity`, `fx`, `api`, `auth`, `idempotency`, `treasury`, `platform`,
`test`, `docs`, `claude`, `tooling`.

## 2. Commit

- Gate first: the `verify-change` skill.
- Stage **explicit paths** (`git add <paths>`), never `git add -A` over someone's work in progress. Check with
  `git diff --staged --stat`.
- One logical change per commit, Conventional Commit, scope = area. A history that reads in the working order
  (ledger → guard → API → idempotency → Kafka → reconciliation → currency → docs) is part of the submission.

```bash
git commit -m "feat(capacity): conditional-update guard with concurrency spec" -m "Why, in one or two lines." -m "Co-Authored-By: …"
```

- End the message with the attribution line from the system reminder when one is given.
- If a hook fails, fix the cause and commit again. Never skip hooks.

## 3. Push and open the PR

```bash
git push -u origin HEAD
gh pr create --base main --title "<type>(<scope>): <summary>" --body-file <scratchpad>/pr.md
```

```markdown
## Summary

What and why; which graded invariant it serves.

## Test plan

- [x] only commands you actually ran, with results (ci:quality, test:e2e counts, runs ×N, compose cold start)
- [ ] what was not verified

## Decisions

Anything a reviewer would ask "why?" about, and where the README says it.

## Risk

What could break (money, ordering, start-up) and how to roll back.
```

End the body with the PR attribution line from the system reminder when one is given.

## 4. After

Report the PR URL and the CI state (`gh pr checks <n>`): `CI passed` is the one that counts (the `ci-pipeline`
skill). Releases and tags: the `release-delivery` skill. **Never merge** and never force-push; add a commit.
