import { Inject, Injectable } from '@nestjs/common';

import { PG_POOL, type Db, type Tx } from '../db/database.js';
import { FX_RATE_PROVIDER, type FxQuote, type FxRateProvider } from '../fx/fx-rate.provider.js';
import { type CurrencyCode, exponentOf } from '../money/currencies.js';
import { BIGINT_MAX, convertMinor, parseRate } from '../money/money.js';
import * as repo from './capacity.repository.js';
import type { Availability, Reservation, ReleaseResult, ReserveResult } from './capacity.types.js';

export interface ReserveInput {
  programId: string;
  invoiceRef: string;
  amountMinor: bigint;
  currency: CurrencyCode;
}

/** A reservation request with its conversion done: what will be reserved, at which rate. */
export interface Priced {
  programId: string;
  invoiceRef: string;
  invoiceAmountMinor: bigint;
  currency: CurrencyCode;
  programCurrency: CurrencyCode;
  quote: FxQuote;
  /** In the program currency. */
  amountMinor: bigint;
}

export type PriceResult =
  { ok: true; priced: Priced } | { ok: false; kind: 'program_not_found' | 'fx_rate_unavailable' };

@Injectable()
export class CapacityService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Db,
    @Inject(FX_RATE_PROVIDER) private readonly fx: FxRateProvider
  ) {}

  /**
   * Converts once, here, at reservation time: reads the program currency and the rate BEFORE any
   * transaction opens, so a slow rate service never holds a database connection or lock.
   */
  async price(input: ReserveInput): Promise<PriceResult> {
    const programCurrency = await repo.findProgramCurrency(this.pool, input.programId);
    if (!programCurrency) {
      return { ok: false, kind: 'program_not_found' };
    }
    const quote: FxQuote | null =
      input.currency === programCurrency
        ? { rate: '1', asOf: new Date(), source: 'same-currency' }
        : await this.fx.getRate(input.currency, programCurrency);
    if (!quote) {
      return { ok: false, kind: 'fx_rate_unavailable' };
    }
    const amountMinor = convertMinor(
      input.amountMinor,
      exponentOf(input.currency),
      exponentOf(programCurrency),
      parseRate(quote.rate)
    );
    return {
      ok: true,
      priced: {
        programId: input.programId,
        invoiceRef: input.invoiceRef,
        invoiceAmountMinor: input.amountMinor,
        currency: input.currency,
        programCurrency,
        quote,
        amountMinor,
      },
    };
  }

  /**
   * Takes the priced amount inside the caller's transaction (which also holds the idempotency record),
   * storing the converted amount with the rate and its timestamp.
   */
  async reserve(tx: Tx, p: Priced, source: string): Promise<ReserveResult> {
    if (p.amountMinor > BIGINT_MAX) {
      return { ok: false, kind: 'insufficient_capacity' }; // larger than any limit can be
    }
    return repo.reserveCapacity(tx, {
      programId: p.programId,
      currency: p.programCurrency,
      invoiceRef: p.invoiceRef,
      invoiceAmountMinor: p.invoiceAmountMinor,
      invoiceCurrency: p.currency,
      amountMinor: p.amountMinor,
      fxRate: p.quote.rate,
      fxRateAt: p.quote.asOf,
      fxSource: p.quote.source,
      source,
    });
  }

  /** Gives back exactly the stored amount. The FX provider is never called here. */
  release(tx: Tx, reservationId: string, source: string): Promise<ReleaseResult> {
    return repo.releaseCapacity(tx, reservationId, source);
  }

  availability(programId: string, asOf?: Date): Promise<Availability | null> {
    return asOf
      ? repo.ledgerAvailability(this.pool, programId, asOf)
      : repo.currentAvailability(this.pool, programId);
  }

  async list(programId: string, q: repo.PageQuery): Promise<Reservation[] | null> {
    if (!(await repo.findProgramCurrency(this.pool, programId))) {
      return null;
    }
    return repo.listReservations(this.pool, programId, q);
  }
}
