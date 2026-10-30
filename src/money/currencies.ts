// ISO 4217 minor-unit exponents for the currencies this service accepts.
// A currency not listed here is rejected at the edge with 400.
export const CURRENCY_EXPONENTS = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  PLN: 2,
  CHF: 2,
  JPY: 0,
} as const satisfies Record<string, number>;

export type CurrencyCode = keyof typeof CURRENCY_EXPONENTS;

export const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_EXPONENTS) as CurrencyCode[];

export const isCurrency = (v: unknown): v is CurrencyCode =>
  typeof v === 'string' && Object.hasOwn(CURRENCY_EXPONENTS, v);

export const exponentOf = (c: CurrencyCode): number => CURRENCY_EXPONENTS[c];
