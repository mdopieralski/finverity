---
name: treasury-kafka
description: >-
  The Kafka (Redpanda) treasury integration: topics, message schemas for adjustments and reconciliation
  snapshots, partitioning by program, the consumer loop with manual offsets, treasury_sequence ordering
  (strictly greater or discard), rebasing only the treasury-owned component while keeping ACTIVE local
  reservations, poison messages, and producing test messages with rpk. Use for src/treasury/, the consumer,
  reconciliation, or "what does a snapshot do?", "how do I send a test message?".
---

# Treasury over Kafka

Owner: the `messaging-engineer` agent (transport, schemas, dedup, transaction boundary). The SQL that changes
programs and the ledger is the `ledger-engineer` agent's (`applyTreasuryAdjustment`, `applyTreasurySnapshot`
in `src/capacity/`), called inside the consumer's transaction.

## Topics and messages

One topic `treasury.capacity.v1`, key = `programId` (per-program ordering within a partition). Two message
types, JSON, validated at the consumer edge:

```jsonc
// adjustment: incremental, from treasury
{ "messageId": "tre-7f3c…", "type": "ADJUSTMENT", "programId": "prg_eur_acme", "treasurySequence": "42",
  "occurredAt": "2026-10-28T10:00:00Z",
  "component": "UTILISED" | "LIMIT", "deltaMinor": "-250000", "currency": "EUR" }

// snapshot: full treasury state for one program
{ "messageId": "tre-8a01…", "type": "SNAPSHOT", "programId": "prg_eur_acme", "treasurySequence": "57",
  "asOf": "2026-10-28T10:05:00Z",
  "creditLimitMinor": "1000000000", "treasuryUtilisedMinor": "120000000", "currency": "EUR" }
```

Amounts are strings of minor units (money-and-fx skill). A currency that differs from the program's → reject.

## Ordering: `treasury_sequence`

- Applied **only if** `msg.treasurySequence > programs.treasury_sequence`, in the same statement that locks
  the row:
  `UPDATE programs SET … , treasury_sequence = $seq WHERE id = $id AND treasury_sequence < $seq RETURNING`. No
  row → stale: discard, record `outcome = stale`, log it with both sequences. **Equal is stale too.**
- Adjustments and snapshots share one sequence per program (treasury's version counter). State that
  assumption.
- Kafka per-partition order is not trusted for correctness; the sequence is. Order only reduces how often we
  discard.

## Snapshot: rebase the treasury component, keep local reservations

```
old = programs row (locked)
new_limit    = msg.creditLimitMinor
new_treasury = msg.treasuryUtilisedMinor
ledger += TREASURY_REBASE, TREASURY_LIMIT,    delta = new_limit    − old.credit_limit_minor   (if ≠ 0)
ledger += TREASURY_REBASE, TREASURY_UTILISED, delta = new_treasury − old.treasury_utilised_minor (if ≠ 0)
programs.credit_limit_minor = new_limit, treasury_utilised_minor = new_treasury, treasury_sequence = seq
programs.reserved_minor     — untouched: ACTIVE reservations stay on top of the new baseline
```

A snapshot **never** deletes or releases local reservations. If the new baseline plus active reservations
exceeds the limit, apply it anyway (treasury owns the limit), log `overcommitted`, and new reservations are
rejected until capacity returns. Documented assumption: the snapshot's utilisation excludes reservations made
through this service (scf-domain skill).

## Consumer loop

- Client: whichever Kafka client the user approved (CLAUDE.md "Open choices"); read the installed version's
  docs. Use it directly rather than Nest's microservice transport when that is what gives manual offset
  control. Write down which and why.
- `autoCommit` off; per message: transaction (idempotency skill) → commit offset.
- Consumer group `program-capacity`. Start from earliest for a new group locally.
- Graceful shutdown: stop fetching, finish the in-flight message, commit, disconnect (Nest `onModuleDestroy` /
  `enableShutdownHooks`).
- Logs: one structured line per message: `messageId`, `programId`, `type`, `sequence`, `outcome` (`applied` |
  `duplicate` | `stale` | `rejected` | `overcommitted` | `error`).

## Producing test messages

`scripts/produce-treasury.ts` (the `messaging-engineer` agent's):
`pnpm run produce -- snapshot prg_eur_acme --seq 5 --limit 1000000000 --utilised 0` prints the message id. By
hand:

```bash
docker compose exec redpanda rpk topic produce treasury.capacity.v1 -k prg_eur_acme
docker compose exec redpanda rpk topic consume treasury.capacity.v1 -n 5
docker compose exec redpanda rpk group describe program-capacity
```

## Tests (`test/reconciliation.spec.ts`, `test/idempotency.spec.ts`)

- `an older snapshot does not roll the state back`: apply seq 10, then seq 9 and seq 10 again → state of seq
  10, two `stale` outcomes, no extra ledger rows.
- `a snapshot does not wipe local active reservations`: reserve via HTTP, apply a newer snapshot → reservation
  still ACTIVE, `reserved_minor` unchanged, available = new_limit − new_treasury − reserved.
- Limit cut below utilisation → applied, available negative, next reservation 422.
- Tests may call the handler directly for precise cases **and** keep at least one end-to-end test through
  Redpanda (Testcontainers or compose) to prove wiring and offset handling.
