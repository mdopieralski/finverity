// Edge validation, by hand: explicit rules, fixed error kinds, field names only (never values).
import type { ReservationStatus } from '../capacity/capacity.types.js';
import type { PageQuery } from '../capacity/capacity.repository.js';
import { DomainError } from '../errors/error-table.js';
import { type CurrencyCode, isCurrency } from '../money/currencies.js';
import { parseMinor } from '../money/money.js';

const PROGRAM_ID = /^prg_[a-z0-9_]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVOICE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

const invalid = (...fields: string[]): DomainError => new DomainError('invalid_request', fields);

export function programId(v: unknown): string {
  if (typeof v !== 'string' || !PROGRAM_ID.test(v)) {
    throw invalid('programId');
  }
  return v;
}

export function reservationId(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) {
    throw invalid('reservationId');
  }
  return v;
}

export function idempotencyKey(v: unknown): string {
  if (typeof v !== 'string' || !IDEMPOTENCY_KEY.test(v)) {
    throw new DomainError('idempotency_key_required');
  }
  return v;
}

export interface ReserveBody {
  invoiceRef: string;
  amountMinor: bigint;
  currency: CurrencyCode;
}

export function reserveBody(body: unknown): ReserveBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('body');
  }
  const b = body as Record<string, unknown>;
  const unknownFields = Object.keys(b).filter((k) => !['invoiceRef', 'amountMinor', 'currency'].includes(k));
  if (unknownFields.length) {
    throw invalid(...unknownFields);
  }
  const amountMinor = parseMinor(b.amountMinor);
  if (amountMinor === null) {
    throw new DomainError('invalid_amount', ['amountMinor']);
  }
  const bad = [
    ...(typeof b.invoiceRef === 'string' && INVOICE_REF.test(b.invoiceRef) ? [] : ['invoiceRef']),
    ...(isCurrency(b.currency) ? [] : ['currency']),
  ];
  if (bad.length) {
    throw invalid(...bad);
  }
  return { invoiceRef: b.invoiceRef as string, amountMinor, currency: b.currency as CurrencyCode };
}

/** An ISO-8601 instant with an explicit offset, not in the future. */
export function asOf(v: unknown, now = new Date()): Date | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (typeof v !== 'string' || !ISO_INSTANT.test(v)) {
    throw invalid('asOf');
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime()) {
    throw invalid('asOf');
  }
  return d;
}

export function onlyQuery(query: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(query).filter((k) => !allowed.includes(k));
  if (extra.length) {
    throw invalid(...extra);
  }
}

export const encodeCursor = (createdAt: Date, id: string): string =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');

export function pageQuery(query: Record<string, unknown>): PageQuery {
  onlyQuery(query, ['status', 'limit', 'cursor']);
  const { status, limit, cursor } = query;
  const out: PageQuery = { limit: 50 };
  if (status !== undefined) {
    if (status !== 'ACTIVE' && status !== 'RELEASED') {
      throw invalid('status');
    }
    out.status = status as ReservationStatus;
  }
  if (limit !== undefined) {
    if (typeof limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100) {
      throw invalid('limit');
    }
    out.limit = Number(limit);
  }
  if (cursor !== undefined) {
    const [t, id] =
      typeof cursor === 'string' ? Buffer.from(cursor, 'base64url').toString('utf8').split('|') : [];
    const createdAt = t ? new Date(t) : new Date(Number.NaN);
    if (!id || !UUID.test(id) || Number.isNaN(createdAt.getTime())) {
      throw invalid('cursor');
    }
    out.after = { createdAt, id };
  }
  return out;
}
