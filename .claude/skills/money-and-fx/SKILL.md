---
name: money-and-fx
description: >-
  Money and currency rules: integer minor units as bigint, ISO 4217 exponents (JPY = 0), decimal strings on
  the wire, rejecting fractional amounts with 400, the injected FxRateProvider with a fixed local table,
  converting once at reservation time with an explicit rounding mode, storing amount + rate + timestamp, and
  releasing exactly what was taken. Use for anything in src/money/ or src/fx/, any amount in a DTO, or "how do
  I convert?", "what about JPY?", "why bigint?".
---

# Money and FX

Owner: the `ledger-engineer` agent. The post-edit hook blocks new `amount…: number`, `parseFloat`, `toFixed`
and `Math.round/floor/ceil` in `src/`, and float column types in migrations.

## Representation

| Where             | Form                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| TypeScript        | `bigint` minor units + `CurrencyCode` (a branded `string`)            |
| Postgres          | `BIGINT` minor units + `CHAR(3)` currency                             |
| JSON (in and out) | `{ "amountMinor": "150000", "currency": "EUR" }` (string, not number) |
| FX rate           | decimal **string** → `NUMERIC(24,12)`; in code a scaled `bigint` pair |

Why strings on the wire: JSON numbers become IEEE-754 doubles in most clients, unsafe above 2^53 and lossy for
anything fractional. CLAUDE.md: "never `number` for amounts that cross a boundary".

Response amounts also carry the exponent so a client can display them:
`{ "amountMinor": "150000", "currency": "EUR", "exponent": 2 }`.

## Validation at the edge (400, fixed message)

- `amountMinor` must match `^[1-9][0-9]{0,17}$`: positive integer, fits in BIGINT. `"1500.50"`, `1500.5`,
  `"1e5"`, `"-1"`, `"0"`, `" 1"`, numbers instead of strings → 400 `invalid_amount`.
- `currency` must be in the supported table (`src/money/currencies.ts`: code → exponent). Unknown → 400.
- Supported locally: EUR (2), USD (2), GBP (2), PLN (2), JPY (0). Three-decimal currencies (KWD, BHD) work by
  the same exponent table; say in the README which are tested.

## Conversion (once, at reservation time)

```
programMinor = ceil( invoiceMinor × rate × 10^(expProgram − expInvoice) )
```

- `rate` = program-currency units per one invoice-currency unit, from `FxRateProvider.getRate(from, to)`
  returning `{ rate: string, asOf: Date, source: string }`.
- Do it in `bigint`: parse the rate string into `numerator / 10^scale`, multiply, adjust the exponent, divide
  with **ceiling** (round up: reserve at least enough cover; a documented business assumption). One helper,
  `convertMinor()`, unit-tested with JPY ↔ EUR, a rate with 12 decimals, and huge amounts.
- Same currency: rate `"1"`, no rounding, still stored.
- Store on the reservation: `invoice_amount_minor`, `invoice_currency`, `amount_minor` (program currency),
  `fx_rate`, `fx_rate_at`, `fx_source`.

## Release (never reconvert)

Release reads `amount_minor` from the reservation row and gives exactly that back. The FX provider is not
called on release. `test/currency.spec.ts` must prove: reserve at rate A, switch the provider to rate B,
release → availability equals its starting value to the minor unit.

## FxRateProvider

- An interface plus a Nest injection token. `FixedTableFxRateProvider` reads a table (env or a TS constant)
  for local running. Tests inject a mutable fake to move the rate between reserve and release.
- Missing pair → a business error (`fx_rate_unavailable`, 422), not a 500.
- README sentence (verbatim intent): _production would use a rate service with a defined fixing policy; fixing
  policy is a business decision, not an engineering one._
