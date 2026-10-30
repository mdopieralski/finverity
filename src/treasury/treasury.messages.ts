// Treasury → this service, topic treasury.capacity.v1, key = programId, JSON value. Amounts are
// strings of minor units, sequences strings of integers (both can exceed 2^53).
import type { TreasuryAdjustment, TreasurySnapshot } from '../capacity/capacity.types.js';

export type TreasuryMessage =
  | ({ messageId: string; type: 'SNAPSHOT' } & TreasurySnapshot)
  | ({ messageId: string; type: 'ADJUSTMENT' } & TreasuryAdjustment);

export type ParseResult =
  { ok: true; message: TreasuryMessage } | { ok: false; messageId?: string; detail: string };

const MESSAGE_ID = /^[\w.:-]{1,128}$/;
const PROGRAM_ID = /^prg_[a-z0-9_]{1,64}$/;
const UNSIGNED = /^(0|[1-9][0-9]{0,17})$/;
const SIGNED = /^-?(0|[1-9][0-9]{0,17})$/;
const CURRENCY = /^[A-Z]{3}$/;

export function parseTreasuryMessage(raw: Buffer | string | null): ParseResult {
  let m: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw === null ? '' : raw.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, detail: 'not a JSON object' };
    }
    m = value as Record<string, unknown>;
  } catch {
    return { ok: false, detail: 'not JSON' };
  }
  const messageId = typeof m.messageId === 'string' && MESSAGE_ID.test(m.messageId) ? m.messageId : undefined;
  const fail = (detail: string): ParseResult => ({ ok: false, ...(messageId ? { messageId } : {}), detail });
  if (!messageId) {
    return fail('messageId missing or malformed');
  }
  const str = (k: string, re: RegExp): string | undefined =>
    typeof m[k] === 'string' && re.test(m[k] as string) ? (m[k] as string) : undefined;
  const programId = str('programId', PROGRAM_ID);
  const sequence = str('treasurySequence', UNSIGNED);
  const currency = str('currency', CURRENCY);
  if (!programId || !sequence || !currency || sequence === '0') {
    return fail('programId, treasurySequence (> 0) and currency are required');
  }
  const base = { messageId, programId, sequence: BigInt(sequence), currency };
  if (m.type === 'SNAPSHOT') {
    const limit = str('creditLimitMinor', UNSIGNED);
    const utilised = str('treasuryUtilisedMinor', UNSIGNED);
    if (!limit || !utilised) {
      return fail('creditLimitMinor and treasuryUtilisedMinor must be non-negative integer strings');
    }
    return {
      ok: true,
      message: {
        ...base,
        type: 'SNAPSHOT',
        creditLimitMinor: BigInt(limit),
        treasuryUtilisedMinor: BigInt(utilised),
      },
    };
  }
  if (m.type === 'ADJUSTMENT') {
    const delta = str('deltaMinor', SIGNED);
    if (!delta || (m.component !== 'LIMIT' && m.component !== 'UTILISED')) {
      return fail('component must be LIMIT or UTILISED and deltaMinor a signed integer string');
    }
    return {
      ok: true,
      message: { ...base, type: 'ADJUSTMENT', component: m.component, deltaMinor: BigInt(delta) },
    };
  }
  return fail('type must be SNAPSHOT or ADJUSTMENT');
}
