---
name: scf-domain
description: >-
  Supply chain finance domain knowledge for this service: programs, funders, buyers, suppliers, credit limits,
  early payment, reservation, release on repayment, treasury, reconciliation, and the exact words to use in
  code, API and README. Also what the take-home is graded on and why each invariant matters in money terms.
  Use when naming anything, writing docs or API fields, or asking "what does X mean here?", "is this the right
  term?", "why does this matter?".
---

# Supply chain finance: the domain

## The story in one paragraph

A **funder** (bank or NBFI) sets up a **program** for a **buyer** (a large corporate) with a **credit limit**,
e.g. USD 10,000,000. The buyer's **suppliers** submit **invoices**. When an invoice is **approved for early
payment**, the funder pays the supplier now (minus a discount), and that amount **reserves** part of the
program's capacity. At maturity the buyer **repays** the funder, and the reservation is **released** back to
the program. **Available capacity** = credit limit − utilisation. The funder's **treasury system** is the book
of record for the limit and for utilisation that happened outside this service. It sends adjustments and
periodic **reconciliation snapshots** over Kafka.

## Words: use these, not the alternatives

| Use                                 | Not                      | Meaning here                                                                            |
| ----------------------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| program                             | facility, account, line  | the financing arrangement with one credit limit and one currency                        |
| credit limit                        | max, cap, budget         | total capacity the funder committed, set by treasury                                    |
| reservation                         | booking, hold, lock      | capacity taken by one approved invoice; `ACTIVE` until released                         |
| release                             | refund, cancel, unlock   | returning a reservation's exact amount on repayment                                     |
| available capacity                  | balance, remaining funds | credit limit − treasury utilisation − active reservations (can be negative after a cut) |
| utilisation                         | usage, spend             | capacity in use: treasury-owned component + local reservations                          |
| treasury adjustment                 | event, update            | an incremental change from treasury (limit change, external drawdown or repayment)      |
| reconciliation snapshot             | sync, dump, refresh      | treasury's full state for a program at a `treasury_sequence`                            |
| ledger entry                        | log, history row         | an immutable row; the source of truth for every figure                                  |
| program currency / invoice currency | base / foreign           | capacity is held in the program currency; an invoice may be in another one              |
| oversubscription                    | overbooking              | reservations exceeding the limit: money paid out without cover                          |
| funder, buyer, supplier             | lender, client, vendor   | the three parties; this service is the funder's                                         |

## What is graded, and why it is money

1. **No oversubscription under concurrency.** Two approvals racing for the last USD 100k both succeed → the
   funder pays USD 200k against USD 100k of cover. Real loss, regulatory breach.
2. **Idempotency.** A retried HTTP call or a redelivered Kafka message applied twice double-reserves (blocks
   good invoices) or double-releases (creates capacity from nothing, then oversubscription).
3. **Reconciliation ordering.** A stale snapshot applied late rolls the limit back to yesterday's number. A
   snapshot that overwrites everything forgets reservations this service made since treasury last looked.
4. **Currency invariant.** Reserve EUR 1,000 at 1.10 (USD 1,100), release after the rate moved to 1.05 (USD
   1,050) → USD 50 of capacity leaks per cycle. Release must return what was taken.

The audience is banks and NBFIs, so **auditability** is part of the product: an auditor asks "what was
available on 3 March at 14:02, and why?" The ledger and `?asOf=` answer it.

## Business decisions we make as documented assumptions (README "Assumptions and trade-offs")

- Rounding when converting into the program currency: round **up** (reserve at least enough cover).
- A snapshot that cuts the limit below current utilisation is applied (treasury is authoritative). Available
  goes negative, new reservations are rejected, existing ones are untouched. Log outcome `overcommitted`.
- The snapshot's utilisation figure is the treasury-owned component and **excludes** reservations made through
  this service (they are re-applied on top). State it; a real integration would agree it with treasury.
- Release of an already-released reservation is a no-op that returns the original release (idempotent).
- Rates come from a fixed table locally. Fixing policy is a business decision, not an engineering one.

## Personas for examples, seeds and curl

Fictional only. Program `prg_eur_acme` (Acme Retail buyer, EUR, limit 10,000,000.00), program `prg_usd_globex`
(Globex Manufacturing, USD, 5,000,000.00) and `prg_jpy_umbrella` (JPY, zero exponent, ¥500,000,000), with
suppliers such as "Nordic Fasteners AB" and "Lusitania Textiles Lda". Never a real company's data.
