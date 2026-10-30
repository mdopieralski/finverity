import { Inject, Injectable } from '@nestjs/common';

import { applyTreasuryAdjustment, applyTreasurySnapshot } from '../capacity/capacity.repository.js';
import { PG_POOL, type Db, withTransaction } from '../db/database.js';
import { log } from '../logging/logger.js';
import { parseTreasuryMessage } from './treasury.messages.js';

export interface MessageMeta {
  topic: string;
  partition: number;
  offset: string;
}

export type HandleOutcome = 'applied' | 'stale' | 'rejected' | 'overcommitted' | 'duplicate';

/**
 * Applies one treasury message exactly once. The broker is at-least-once; exactly-once comes from here:
 * the processed_messages row and the business effect are written in ONE transaction, and the caller
 * commits the Kafka offset only after this resolves. A crash in between means redelivery, which this
 * dedup turns into a no-op.
 *
 * Throws only for transient failures (database down): the offset is then not committed and the
 * message is retried. Invalid messages are recorded as `rejected` and acknowledged, so one poison
 * message cannot block its partition.
 */
@Injectable()
export class TreasuryHandler {
  constructor(@Inject(PG_POOL) private readonly pool: Db) {}

  async handle(value: Buffer | string | null, meta: MessageMeta): Promise<HandleOutcome> {
    const parsed = parseTreasuryMessage(value);
    // A message without a usable id is deduped on its position instead (it can only ever be rejected).
    const messageId = parsed.ok
      ? parsed.message.messageId
      : (parsed.messageId ?? `invalid:${meta.topic}:${meta.partition}:${meta.offset}`);

    const { outcome, detail } = await withTransaction(this.pool, async (tx) => {
      const claimed = await tx.query(
        `INSERT INTO processed_messages (message_id, topic, partition, "offset", outcome)
         VALUES ($1, $2, $3, $4, 'rejected') ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
        [messageId, meta.topic, meta.partition, meta.offset]
      );
      if (claimed.rowCount === 0) {
        return { outcome: 'duplicate' as const, detail: undefined };
      }
      const result = !parsed.ok
        ? { outcome: 'rejected' as const, detail: parsed.detail }
        : parsed.message.type === 'SNAPSHOT'
          ? await applyTreasurySnapshot(tx, parsed.message, `kafka:${messageId}`)
          : await applyTreasuryAdjustment(tx, parsed.message, `kafka:${messageId}`);
      await tx.query('UPDATE processed_messages SET outcome = $2, detail = $3 WHERE message_id = $1', [
        messageId,
        result.outcome,
        result.detail ?? null,
      ]);
      return result;
    });

    log(outcome === 'rejected' || outcome === 'overcommitted' ? 'warn' : 'info', 'treasury message', {
      messageId,
      programId: parsed.ok ? parsed.message.programId : undefined,
      type: parsed.ok ? parsed.message.type : undefined,
      sequence: parsed.ok ? parsed.message.sequence : undefined,
      outcome,
      detail,
      ...meta,
    });
    return outcome;
  }
}
