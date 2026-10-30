---
name: idempotency
description: >-
  How retries and redeliveries are made safe: the Idempotency-Key header on POST reservations (unique
  constraint, request hash, replay of the original response, 409 on a different body, concurrent same-key
  requests), and Kafka consumer-side dedup in processed_messages in the same transaction as the effect, with
  the offset committed after commit. Use for src/idempotency/, the consumer's transaction boundary, or "what
  if the client retries?", "what if Kafka redelivers?".
---

# Idempotency

Owners: HTTP side the `api-engineer` agent; Kafka side the `messaging-engineer` agent. Tables come from the
`ledger-engineer` agent's migrations (ask it, or edit `migrations/` with the user's OK).

README sentence (verbatim intent): _the broker guarantees at-least-once, so exactly-once is achieved by
consumer-side dedup, not by the broker._

## HTTP: `Idempotency-Key` on `POST /programs/:id/reservations`

```sql
idempotency_keys (
  subject        TEXT NOT NULL,          -- JWT `sub`: keys are scoped per client
  key            TEXT NOT NULL,
  request_hash   TEXT NOT NULL,          -- sha256 of method + path + canonical JSON body
  response_status INT  NOT NULL,
  response_body  JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject, key)
)
```

Flow, in **one** transaction with the reservation:

1. Header missing or not 1–255 printable chars → 400 `idempotency_key_required`.
2. `INSERT INTO idempotency_keys … ON CONFLICT DO NOTHING RETURNING` a placeholder row first. If another
   request with the same key is in flight, this INSERT **blocks** on the unique index until that transaction
   ends. That is the concurrency control for duplicate keys; no extra lock.
3. Conflict (row exists): compare `request_hash`. Same → return the stored status and body (a replay, log
   outcome `replayed`). Different → 409 `idempotency_key_reused`.
4. New: run the reservation (ledger-model skill), then `UPDATE` the placeholder with the final status and body
   **including business rejections** (insufficient capacity is replayed as the same 422, so a retry cannot
   suddenly succeed after capacity frees up and pay twice).
5. COMMIT. If the transaction rolls back (crash, 500), the key is gone and a retry runs fresh: correct,
   because nothing happened.

Canonicalise the body before hashing (sorted keys) so `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same
request. Retention: none (out of scope); README "Limitations" mentions a TTL sweep as a next step.

Release (`POST /reservations/:id/release`) is idempotent by state: `… WHERE status = 'ACTIVE'` matches once;
the second call finds `RELEASED` and returns the original release. No key needed; say so.

## Kafka: dedup in `processed_messages`

```sql
processed_messages (
  message_id   TEXT PRIMARY KEY,           -- from the payload `messageId` (or a header): treasury's id
  topic        TEXT NOT NULL,
  partition    INT  NOT NULL,
  "offset"     BIGINT NOT NULL,
  outcome      TEXT NOT NULL,              -- applied | stale | rejected
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

Per message:

```
BEGIN
  INSERT INTO processed_messages (...) ON CONFLICT (message_id) DO NOTHING RETURNING message_id
  no row → duplicate: COMMIT (nothing to do), log outcome=duplicate
  row    → apply the effect (adjustment or snapshot, treasury-kafka skill), set outcome
COMMIT
then commit the Kafka offset (offset + 1)
```

- **Offset after COMMIT, never before.** Crash between COMMIT and offset commit → redelivery → dedup catches
  it. Crash before COMMIT → nothing happened → redelivery applies it. Both are correct; that is the whole
  argument.
- Auto-commit **off**. Commit per message (simple) or per batch after every message in it committed.
- A message that fails validation is recorded as `rejected` (in the same kind of transaction) and its offset
  committed, so one poison message cannot block a partition. A DLQ topic is a documented next step.
- A transient error (DB down) is **not** recorded: don't commit the offset, let the consumer retry/back off.
- Dedup on the business message id, not on topic/partition/offset (a producer retry gets a new offset).

## Tests (`test/idempotency.spec.ts`)

- `the same Idempotency-Key returns the original result` (status, body, one ledger row, reserved unchanged).
- same key, different body → 409, nothing written.
- N parallel requests with one key → exactly one reservation, all responses identical.
- `the same Kafka message is applied once`: produce (or hand the handler) the same message twice → one ledger
  row, one processed_messages row.
