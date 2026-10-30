import type { CurrencyCode } from '../money/currencies.js';
import { parseRate } from '../money/money.js';

export const FX_RATE_PROVIDER = Symbol('FX_RATE_PROVIDER');

export interface FxQuote {
  /** Units of `to` per one unit of `from`, as an exact decimal string. */
  rate: string;
  /** When the rate was fixed. Stored on the reservation. */
  asOf: Date;
  /** Where it came from. Stored on the reservation. */
  source: string;
}

/**
 * Where exchange rates come from. Called once, at reservation time; never on release.
 * Production would use a rate service with a defined fixing policy; fixing policy is a business
 * decision, not an engineering one.
 */
export interface FxRateProvider {
  /** Returns null when no rate is available for the pair. */
  getRate(from: CurrencyCode, to: CurrencyCode): Promise<FxQuote | null>;
}

/** Built-in local table: indicative rates for running the service locally, not market data. */
export const DEFAULT_FX_TABLE =
  'USD/EUR=0.909091,EUR/USD=1.1,GBP/EUR=1.17,EUR/GBP=0.854701,PLN/EUR=0.232558,EUR/PLN=4.3,JPY/EUR=0.006154,EUR/JPY=162.5,USD/JPY=147.75,JPY/USD=0.006768,CHF/EUR=1.06,EUR/CHF=0.943396,GBP/USD=1.287,USD/GBP=0.777001,PLN/USD=0.255814,USD/PLN=3.909091';

export function parseFxTable(table: string): Map<string, string> {
  const rates = new Map<string, string>();
  for (const entry of table
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^([A-Z]{3})\/([A-Z]{3})=([0-9.]+)$/.exec(entry);
    if (!m) {
      throw new Error(`FX_RATES entry "${entry}" must look like USD/EUR=0.909091`);
    }
    parseRate(m[3] as string); // fail at start-up, not on the first reservation for this pair
    rates.set(`${m[1]}/${m[2]}`, m[3] as string);
  }
  return rates;
}

/** A fixed table loaded at start-up (FX_RATES or the built-in one). */
export class FixedTableFxRateProvider implements FxRateProvider {
  private readonly rates: Map<string, string>;
  private readonly loadedAt = new Date();

  constructor(table: string) {
    this.rates = parseFxTable(table || DEFAULT_FX_TABLE);
  }

  async getRate(from: CurrencyCode, to: CurrencyCode): Promise<FxQuote | null> {
    const rate = this.rates.get(`${from}/${to}`);
    return rate ? { rate, asOf: this.loadedAt, source: 'fixed-table' } : null;
  }
}
