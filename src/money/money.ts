// Money is integer minor units as bigint inside the service and decimal strings on the wire.
// No floating point anywhere: a rate is parsed into an exact fraction and applied with bigint arithmetic.

/** Positive integer, no sign, no leading zeros, fits in Postgres BIGINT. */
const MINOR_PATTERN = /^[1-9][0-9]{0,17}$/;
/** Postgres BIGINT's largest value: no stored amount can exceed it. */
export const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * The largest credit limit or treasury utilisation a program can carry: half of BIGINT, so that
 * `limit − utilised − reserved` (the availability the guard computes in SQL) can never overflow either.
 */
export const MAX_TREASURY_MINOR = BIGINT_MAX / 2n;

export const MINOR_AMOUNT_PATTERN = MINOR_PATTERN.source;

/** Parses a client amount ("1250000") into minor units. Returns null for anything else. */
export function parseMinor(v: unknown): bigint | null {
  if (typeof v !== 'string' || !MINOR_PATTERN.test(v)) {
    return null;
  }
  const n = BigInt(v);
  return n <= BIGINT_MAX ? n : null;
}

/** A positive decimal rate ("0.909091", "150") as an exact fraction numerator / denominator. */
export interface Rate {
  numerator: bigint;
  denominator: bigint;
}

const RATE_PATTERN = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,12})?$/;

export function parseRate(v: string): Rate {
  if (!RATE_PATTERN.test(v)) {
    throw new Error(`invalid rate "${v}"`);
  }
  const [whole = '0', frac = ''] = v.split('.');
  const numerator = BigInt(whole + frac);
  if (numerator === 0n) {
    throw new Error('rate must be positive');
  }
  return { numerator, denominator: 10n ** BigInt(frac.length) };
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b; // a, b > 0

/**
 * Converts an amount in minor units of one currency into minor units of another.
 *
 *   result = ceil( amountMinor × rate × 10^(toExponent − fromExponent) )
 *
 * `rate` is units of the target currency per one unit of the source currency. Rounds UP: a
 * reservation always covers at least the invoice (a documented business assumption).
 */
export function convertMinor(
  amountMinor: bigint,
  fromExponent: number,
  toExponent: number,
  rate: Rate
): bigint {
  if (amountMinor <= 0n) {
    throw new Error('amount must be positive');
  }
  let numerator = amountMinor * rate.numerator;
  let denominator = rate.denominator;
  const shift = toExponent - fromExponent;
  if (shift > 0) {
    numerator *= 10n ** BigInt(shift);
  } else if (shift < 0) {
    denominator *= 10n ** BigInt(-shift);
  }
  return ceilDiv(numerator, denominator);
}
