---
name: nestjs-service
description: >-
  How the NestJS HTTP service is built here: module layout, the four endpoints and their contracts, the global
  JWT guard (every endpoint, reads included) and the token script, validation of amounts and ids, the error
  table (kind → status → fixed client message → log outcome), one structured log line per request, cursor
  pagination, config from env. Use for src/http/, src/auth/, src/errors/, src/logging/, src/config/, main.ts,
  or "what status code?", "how do I get a token?", "how is X validated?".
---

# NestJS service

Owner: the `api-engineer` agent. Versions change: read `@nestjs/*` versions in `package.json`, the installed
types in `node_modules/@nestjs/*`, then that major's docs (https://docs.nestjs.com). Say which you checked.

## Layout

```
src/
  main.ts                 bootstrap, JSON logger, shutdown hooks, global pipes/filters/guard
  app.module.ts
  config/                 typed env (DATABASE_URL, KAFKA_BROKERS, JWT_SECRET, JWT_ISSUER, FX_TABLE…), fail fast
  auth/                   JwtAuthGuard (global APP_GUARD), token verification
  http/                   controllers + DTOs: programs, reservations, availability
  errors/                 DomainError kinds, the error table, the global exception filter
  logging/                request-log interceptor (one line per request)
  idempotency/            Idempotency-Key handling (idempotency skill)
  docs/                   OpenAPI document, error-table decorator, docs auth middleware (api-docs skill)
  capacity/ money/ fx/    ledger-engineer's (ledger-model, money-and-fx skills)
  treasury/               messaging-engineer's (treasury-kafka skill)
  db/                     pg pool provider, withTransaction(fn)
scripts/mint-token.ts     `pnpm run token [-- --sub reviewer --ttl 1h]` prints a JWT
```

Controllers are thin: parse → call a use case → map the result. No SQL and no money math in controllers. Every
controller and DTO carries its `@nestjs/swagger` decorators from the first commit (the `api-docs` skill): the
spec is generated from them and contract-tested.

## Endpoints (exactly these four; ask before adding any)

| Method | Path                         | Success                    | Notes                                                                          |
| ------ | ---------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| POST   | `/programs/:id/reservations` | 201 reservation            | `Idempotency-Key` required; body `invoiceRef`, `amountMinor`, `currency`       |
| POST   | `/reservations/:id/release`  | 200 reservation (RELEASED) | idempotent by state                                                            |
| GET    | `/programs/:id/availability` | 200 availability           | optional `?asOf=` ISO-8601 with offset                                         |
| GET    | `/programs/:id/reservations` | 200 page                   | `?status=ACTIVE&limit=50&cursor=…`, cursor = opaque base64 of (created_at, id) |

Availability body:
`{ programId, currency, exponent, creditLimitMinor, treasuryUtilisedMinor, reservedMinor, availableMinor, treasurySequence, asOf }`,
all amounts as strings.

## Auth

- Global `APP_GUARD` verifying `Authorization: Bearer <jwt>` (HS256 locally, `JWT_SECRET` from env; check
  `exp`, `iss`, `aud` if set). Missing/invalid/expired → 401 with the fixed message; never say which check
  failed.
- **No public routes.** No `@Public()` escape hatch (the pre-edit hook denies it). No dev token endpoint: the
  token comes from `pnpm run token`, which reads the same `JWT_SECRET`. The compose service healthcheck must
  not need an open route (use a TCP check or let `depends_on` wait on Postgres/Redpanda only).
- **Docs too:** `/docs` (Basic, password = JWT) and `/openapi.json` (Bearer) sit behind the same verifier via
  a middleware, because `SwaggerModule` routes bypass guards (the `api-docs` skill).
- `sub` scopes idempotency keys. No roles or tenancy (out of scope; README says so).
- `@nestjs/jwt` is in the Nest family; anything beyond (passport) needs the user's OK.

## Validation

- Ids: program ids match `^prg_[a-z0-9_]{1,64}$` (or whatever the seed uses; one regex), reservation ids are
  UUIDs. Bad format → 400, unknown → 404.
- Amounts: money-and-fx skill. Unknown fields → 400 (whitelist + forbid non-whitelisted).
- Validation library: see CLAUDE.md "Open choices". With class-validator use a global
  `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` and custom messages
  mapped to the error table.

## Error table (the only source of client messages)

| Kind                       | HTTP | Client message (constant)                                       | Log `outcome`     |
| -------------------------- | ---- | --------------------------------------------------------------- | ----------------- |
| `unauthenticated`          | 401  | `Authentication required.`                                      | `unauthenticated` |
| `invalid_request`          | 400  | `The request is invalid.` (+ field names, never values)         | `invalid`         |
| `invalid_amount`           | 400  | `amountMinor must be a positive integer string in minor units.` | `invalid`         |
| `idempotency_key_required` | 400  | `Idempotency-Key header is required.`                           | `invalid`         |
| `program_not_found`        | 404  | `Program not found.`                                            | `not_found`       |
| `reservation_not_found`    | 404  | `Reservation not found.`                                        | `not_found`       |
| `idempotency_key_reused`   | 409  | `Idempotency-Key was already used with a different request.`    | `conflict`        |
| `insufficient_capacity`    | 422  | `Insufficient capacity on this program.`                        | `rejected`        |
| `fx_rate_unavailable`      | 422  | `No exchange rate is available for this currency pair.`         | `rejected`        |
| `service_unavailable`      | 503  | `Service temporarily unavailable.`                              | `unavailable`     |
| anything else              | 500  | `Internal error.`                                               | `error`           |

Body shape: `{ "error": { "code": "<kind>", "message": "<constant>", "requestId": "<id>" } }`. The filter maps
`DomainError` kinds through this table; any other exception is a 500 with the constant, and the detail goes
only to the log. `test/validation.spec.ts` asserts no response contains SQL, stack traces or `err.message`.

Insufficient capacity is a business outcome: 422 (the request was valid, the program can't take it). Write the
choice of 422 over 409 in the README.

## One log line per request

An interceptor (plus the filter for errors) writes exactly one JSON line per request: `ts`, `level`,
`requestId` (from `X-Request-Id` or generated, echoed back), `method`, `route` (the pattern, not the raw URL),
`status`, `durationMs`, `outcome` (one word: `reserved`, `released`, `replayed`, `read`, `rejected`,
`invalid`, `conflict`, `not_found`, `unauthenticated`, `unavailable`, `error`), `programId`, `sub`. Never the
token, the body or amounts beyond `amountMinor`. Use Nest's built-in logger in JSON mode if the installed
version has it; another logging library needs the user's OK. These fields are the metrics dimensions (README).
