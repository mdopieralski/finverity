---
name: submission-check
description: >-
  The final go/no-go before the take-home is handed in: a clean-clone cold start with one command, the five
  must-have tests and the seven spec files green, the four graded invariants each traced to code + test +
  README, the README sections and required sentences, out-of-scope documented, no secrets, a readable git
  history. Use for "are we done?", "ready to submit?", "final check", "go/no-go".
---

# Submission check

Run by the main session with the `test-engineer` agent (runs) and the `code-reviewer` agent (whole-repo
review). Tick only what you ran. "Not ready, here is why" is a good result.

## 1. Automated gate

```bash
pnpm run ci:quality
pnpm run test:e2e                 # three times in a row; any flake is a blocker
pnpm run audit:submission         # spec files, must-have titles, README order and sentences, compose, token script
```

## 2. Clean-clone cold start (as the reviewer)

```bash
git clone <repo> <scratchpad>/cold && cd <scratchpad>/cold
docker compose up --build         # nothing else first: no pnpm install, no .env copy
```

Then the README Quick start, **copied from the README**: token, availability for two programs in two
currencies, reserve, replay, 409, release, snapshot. Note the time to healthy. Tear down with
`docker compose down -v` (the hook asks).

### Swagger walk-through

Open `http://localhost:3000/docs`: without credentials → 401 and a browser prompt; with the token as password
→ Swagger UI, version = `package.json`, Authorize pre-filled. _Try it out_ on all four operations, including a
replay and a 409. `curl -s localhost:3000/openapi.json` without a token → 401.

## 3. The four invariants, traced

For each: the code (`file:line`), the test (title), the README paragraph.

| Invariant                  | Code                                                             | Test                                              | README              |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------- | ------------------- |
| No oversubscription        | conditional UPDATE + ledger in one tx                            | concurrent N vs N−1; one unit over writes nothing | Behaviour decisions |
| Idempotency (HTTP + Kafka) | idempotency_keys / processed_messages in tx; offset after commit | same key; different body 409; Kafka once          | Behaviour decisions |
| Reconciliation ordering    | `treasury_sequence < $seq` guard; rebase treasury component only | older snapshot; keeps local reservations          | Behaviour decisions |
| Currency invariant         | convert once, stored rate + time, release by stored amount       | rate A → B returns to start exactly               | Behaviour decisions |

Plus: ledger recompute test, every endpoint 401 without a token, no internal detail in errors.

## 4. Documents

- README sections in order (submission-readme skill), the required sentences, every out-of-scope item listed.
- Decision records linked. No TODOs that a reviewer would read as unfinished work without a "next steps"
  entry.

## 5. CI and docs

- The latest run on the release PR: every job green, `CI passed` green (`gh pr checks`).
- `pnpm run docs:check` (export current) and `pnpm run docs:lint` clean; README Scripts and Environment tables
  match (`audit:submission`).

## 6. Hygiene

- `git log --oneline` reads as the working order. No secrets:
  `git log -p | grep -iE "secret|password|BEGIN .*PRIVATE"` shows only the documented dev default.
- No sample Nest controller left, no `console.log` debugging, no skipped tests
  (`grep -rn "\.skip\|\.only" test src`).

## 7. Report

Go / no-go, the table from §3 filled with paths, timings, and anything not verified. On go: the
`release-delivery` skill (version, tag, release notes, hand-off message).
