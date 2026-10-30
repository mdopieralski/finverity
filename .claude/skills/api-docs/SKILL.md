---
name: api-docs
description: >-
  The API documentation surface, ingrid-style but NestJS-native: OpenAPI 3.1 generated from @nestjs/swagger
  decorators, Swagger UI at /docs and the spec at /openapi.json, both behind the same JWT (Basic auth with the
  token as password for the browser page, Bearer for the JSON), version from package.json, amounts as strings,
  error examples built from the error table, the exported docs/api/openapi.json kept in sync, Redocly lint,
  and contract tests that fail when docs drift from code. Use for src/docs/, any decorator, DTO or endpoint
  change, or "Swagger", "OpenAPI", "/docs", "the spec is wrong".
---

# API docs (Swagger / OpenAPI)

Owner: the `api-engineer` agent (decorators, `src/docs/`, `redocly.yaml`, the export). Contract tests: the
`test-engineer` agent. Pattern taken from the ingrid repo (`~/ingrid`: `src/docs/docs.ts`,
`test/docs.test.ts`, `redocly.yaml`), adapted to Nest and to "every endpoint authenticated".

## Decided (user, 2026-10-28)

- **Spec source: `@nestjs/swagger` decorators.** The spec is generated at boot from controllers and DTOs.
- **Docs behind auth too.** No unauthenticated route exists, docs included.

## Surface

| Path            | What                      | Auth                                                                 |
| --------------- | ------------------------- | -------------------------------------------------------------------- |
| `/docs`         | Swagger UI (+ its assets) | HTTP Basic: any username, **password = a JWT** from `pnpm run token` |
| `/openapi.json` | the OpenAPI 3.1 document  | `Authorization: Bearer <jwt>` (Basic with the JWT also accepted)     |
| API routes      | the four endpoints        | Bearer JWT (global guard)                                            |

Why Basic for the page: a browser cannot attach a bearer header when it navigates to a URL, but it prompts for
Basic credentials natively and resends them for every asset under `/docs`. Using the JWT as the password keeps
**one** credential and one signing key; there is no docs password to leak. Wrong or missing → `401` with
`WWW-Authenticate: Basic realm="API docs"` and the error table's constant body.

`SwaggerModule.setup` registers its routes on the HTTP adapter, **outside** Nest's guards, so the global
`APP_GUARD` does not cover them. Protect them with a middleware mounted **before** `SwaggerModule.setup` in
`main.ts` (`app.use(['/docs', '/openapi.json'], docsAuth)`), reusing the same JWT verifier as the guard.
`test/auth.spec.ts` proves it (below). Never mark anything public.

Served only when `API_DOCS=1` (on in docker compose, default off): production would publish the spec from CI
instead (README "Limitations").

## Building the document

```ts
// src/docs/openapi.ts (api-engineer)
const config = new DocumentBuilder()
  .setTitle('Program capacity')
  .setVersion(pkg.version) // always package.json's version (ingrid: info.version follows package.json)
  .setDescription(DESCRIPTION) // markdown: what a program/reservation is, money format, idempotency, errors
  .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'jwt')
  .addSecurityRequirements('jwt') // global: every operation needs the token
  .build();
const document = SwaggerModule.createDocument(app, config);
SwaggerModule.setup('docs', app, document, {
  jsonDocumentUrl: 'openapi.json', // check the option name in the installed @nestjs/swagger version
  swaggerOptions: { persistAuthorization: true, tryItOutEnabled: true },
});
```

Read the installed `@nestjs/swagger` version and its docs first: option names (`jsonDocumentUrl`, `raw`,
`ui`), the OpenAPI version it emits (3.0 vs 3.1), and whether the CLI plugin is worth enabling. Say which you
checked. If it emits 3.0, keep 3.0 and say so; don't post-process the document into something else.

### Decorator rules

- **Every operation:** `@ApiTags`, `@ApiOperation({ summary, description })`, `operationId` (stable,
  camelCase: `createReservation`, `releaseReservation`, `getAvailability`, `listReservations`).
- **Amounts:**
  `@ApiProperty({ type: 'string', pattern: '^[1-9][0-9]{0,17}$', example: '1250000', description: 'Integer minor units of `currency` (EUR 12,500.00 = "1250000"; JPY has no minor unit)' })`.
  Never `type: Number` for money.
- **Headers:** `@ApiHeader({ name: 'Idempotency-Key', required: true, schema: { maxLength: 255 } })` on the
  reserve operation; `X-Request-Id` documented on responses.
- **Query:** `asOf` (`format: date-time`), `limit` (1–100, default 50), `cursor` (opaque), `status`.
- **Errors from the error table, never hand-typed:** one decorator
  `@ApiErrors('program_not_found', 'insufficient_capacity', …)` in `src/docs/` that reads
  `src/errors/error-table.ts` and emits each status with the `ErrorBody` schema and an example whose `message`
  is the table's constant. Docs and runtime then share one source, like ingrid's fixed error strings.
- **Examples:** realistic seed data (`prg_eur_acme`, `INV-1001`, the scf-domain skill personas). A 201, a
  replayed 201, a 409, a 422 for insufficient capacity, availability with and without `asOf`.
- **Description** (the top of `/docs`): the money format, the Idempotency-Key semantics, ordering of
  reservations in the list, that releases return exactly the reserved amount, and how to get a token.

## The exported spec

`pnpm run docs:export` boots the app module without listening (no DB needed: provide stubs only for what
`createDocument` touches, or build the document in a small script) and writes **`docs/api/openapi.json`**. It
is committed so a reviewer can read the contract without running anything, and linked from the README.

- It is generated: never edit it by hand (the pre-edit hook denies it). Change decorators, re-export.
- CI runs `pnpm run docs:check` = export + `git diff --exit-code docs/api/openapi.json`, so a stale export
  fails the PR.
- `pnpm run docs:lint` = Redocly at a pinned version via `pnpm dlx` (ingrid:
  `pnpm --package=@redocly/cli@<ver> dlx redocly lint`), rules in `redocly.yaml` (`extends: [recommended]`;
  turn rules off only with a comment saying why).

## Contract tests: docs cannot drift (`test/docs.contract.spec.ts`)

Mirrors ingrid's test group F:

1. `/openapi.json` with a token serves the spec, `info.version` equals `package.json`, the paths are exactly
   the four endpoints, and every operation has the `jwt` security requirement.
2. `/docs` with Basic(JWT) serves Swagger UI, and every asset the page loads answers 200 with the same
   credentials.
3. Every response body the e2e suites receive validates against the spec's schema for that path + status (Ajv
   2020 for 3.1 or draft-07 for 3.0; `ajv` is test tooling). A shared `expectMatchesSpec(res, method, path)`
   helper in `test/helpers/` is used by the other specs too.
4. Every error body's `message` is the one the spec documents for that status (examples come from the table).
5. Every documented status for an operation is reachable in some test, or listed in the test as deliberately
   unreached with the reason.

And in `test/auth.spec.ts`: **iterate the spec's own paths and methods** and assert 401 without a token, with
a forged signature and with an expired token, plus `/docs`, a `/docs` asset and `/openapi.json` without
credentials. A new endpoint is then covered automatically.

## When something changes

An endpoint, DTO, status code or error message changes → in the **same PR**: decorators,
`pnpm run docs:export`, the README API section, and the contract test if a status was added. The post-edit
hook reminds you; the code-reviewer agent checks it.
