import type { CurrencyCode } from '../money/currencies.js';

export type ReservationStatus = 'ACTIVE' | 'RELEASED';

export interface Reservation {
  id: string;
  programId: string;
  invoiceRef: string;
  invoiceAmountMinor: bigint;
  invoiceCurrency: CurrencyCode;
  /** In the program currency: what the reservation took, and exactly what its release gives back. */
  amountMinor: bigint;
  currency: CurrencyCode;
  fxRate: string;
  fxRateAt: Date;
  fxSource: string;
  status: ReservationStatus;
  createdAt: Date;
  releasedAt: Date | null;
}

export interface Availability {
  programId: string;
  currency: CurrencyCode;
  creditLimitMinor: bigint;
  treasuryUtilisedMinor: bigint;
  reservedMinor: bigint;
  /** creditLimit − treasuryUtilised − reserved. Negative after treasury cuts the limit below utilisation. */
  availableMinor: bigint;
  treasurySequence: bigint;
  /** null = now (from the cache); a date = folded from the ledger up to that instant. */
  asOf: Date | null;
}

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; kind: 'insufficient_capacity' | 'invoice_already_reserved' };

export type ReleaseResult =
  | { ok: true; reservation: Reservation; alreadyReleased: boolean }
  | { ok: false; kind: 'reservation_not_found' };

export type TreasuryOutcome =
  | { outcome: 'applied' | 'stale' | 'overcommitted'; detail?: string }
  | { outcome: 'rejected'; detail: string };

export interface TreasurySnapshot {
  programId: string;
  sequence: bigint;
  currency: string;
  creditLimitMinor: bigint;
  treasuryUtilisedMinor: bigint;
}

export interface TreasuryAdjustment {
  programId: string;
  sequence: bigint;
  currency: string;
  component: 'LIMIT' | 'UTILISED';
  deltaMinor: bigint;
}
