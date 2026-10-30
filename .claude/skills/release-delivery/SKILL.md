---
name: release-delivery
description: >-
  Delivering the take-home: version and tag it (SemVer from Conventional Commits, package.json version feeding
  the OpenAPI info.version), the release PR with the full gate (audit:submission, e2e, compose smoke), the
  GitHub release with notes, and the hand-off message with the repo link, how to run it, and where the docs
  and decisions are. Plain GitHub flow, not ingrid's release train. Use for "release", "tag", "version",
  "deliver", "hand it in", "send it to the reviewer".
---

# Release and delivery

Owner: the main session (it integrates and ships), with the `docs-engineer` agent for the notes and the
`test-engineer` agent for the gate runs. The user merges and sends.

## Flow: GitHub flow, deliberately

ingrid's `docs/RELEASE_MANAGER.md` describes a release train (`scope/*` → `release/*` → `main`) and says
itself it is too heavy for one or two people shipping one service. This take-home has one author and one
delivery, so: work branches → PR into `main` (squash) → tag on `main`. Don't build the train.

## Versioning

- SemVer. Work happens on `0.x`; the delivered version is `1.0.0` (the contract the reviewer sees). Later
  changes after feedback: `fix` → patch, `feat` → minor.
- `package.json` `version` is the single source: `@nestjs/swagger`'s `DocumentBuilder.setVersion(pkg.version)`
  puts it in `/openapi.json` and `docs/api/openapi.json` (the api-docs skill), and the contract test asserts
  it.

## 1. Release PR

```bash
git switch main && git pull
git switch -c chore/release-v1.0.0
pnpm version 1.0.0 --no-git-tag-version     # package.json only; the tag is made on main
pnpm run docs:export                        # spec carries the new version
git commit -am "chore(release): v1.0.0"
gh pr create --base main --title "chore(release): v1.0.0" --body-file <scratchpad>/release.md
```

The release PR body is the `submission-check` skill's report: the invariant table with paths, test counts,
cold-start time, and what was not verified.

**Full gate on this PR:** CI green **plus** `pnpm run audit:submission` (add it to `CI passed`'s `needs` in
this PR, from now on it stays) and the `submission-check` skill run by hand. Any blocker → `fix:` PR first.

## 2. Tag and release (after the user merges)

```bash
git switch main && git pull
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
gh release create v1.0.0 --verify-tag --title "v1.0.0" --notes-file <scratchpad>/notes.md
```

Release notes (`docs-engineer` agent): what the service does in two lines; the four invariants and the test
that proves each; how to run (`docker compose up --build`, token, `/docs`); known limitations (link the README
section). Conventional Commit history can seed it (`gh release create --generate-notes` as a draft, then
edit).

Ask the user before pushing a tag: tags are public in a public repo and hard to take back.

## 3. Hand-off

A short message the user sends to the reviewer (draft it, the user sends it):

- repo link and the tag `v1.0.0`
- "run: `docker compose up --build`, then the Quick start; Swagger at `http://localhost:3000/docs` (password =
  the token from `pnpm run token` or the in-container command)"
- where to look first: `test/` listing, README "Behaviour decisions", "Assumptions and trade-offs"
- one line on what was deliberately left out (README "Limitations")

## After feedback

Fixes go on `fix/…` branches into `main`, then `v1.0.1`. Never move or delete a pushed tag.
