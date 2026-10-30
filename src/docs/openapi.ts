import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { INestApplication } from '@nestjs/common';
import type { Express } from 'express';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

import type { Config } from '../config/config.js';
import type { TokenVerifier } from '../auth/token-verifier.js';
import { docsAuth } from './docs-auth.middleware.js';

/** package.json's version: the spec's info.version always follows it. */
export function packageVersion(): string {
  const path = ['../../package.json', '../../../package.json']
    .map((p) => fileURLToPath(new URL(p, import.meta.url)))
    .find((p) => existsSync(p) && JSON.parse(readFileSync(p, 'utf8')).name === 'program-capacity');
  return path ? (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version : '0.0.0';
}

const DESCRIPTION = `
Tracks a supply chain finance program's credit capacity in real time: invoices approved for early payment
**reserve** capacity, repayment **releases** it, and the funder's treasury system adjusts and reconciles the
limit over Kafka.

### Authentication
Every operation needs \`Authorization: Bearer <JWT>\` (HS256, signed with the service's \`JWT_SECRET\`).
Locally: \`pnpm run token\`. Use **Authorize** above; _Try it out_ then sends the token.

### Money
Every amount is a **string of integer minor units** in the currency next to it: EUR 12,500.00 is \`"1250000"\`,
¥500 is \`"500"\` (JPY has no minor unit). Fractions, numbers and exponents are rejected with 400.
Responses carry \`exponent\` so a client can format them.

### Currency conversion
An invoice in another currency is converted into the program currency **once, at reservation time**, rounded
up, and the rate and its timestamp are stored on the reservation. A release gives back exactly the stored
amount; it is never reconverted.

### Idempotency
\`POST /programs/{programId}/reservations\` requires an \`Idempotency-Key\`. The same key with the same body
returns the original response (header \`Idempotent-Replayed: true\`); with a different body it is a 409.
Releases are idempotent by state.

### Errors
\`{ "error": { "code", "message", "requestId" } }\`. Messages are fixed strings per code; internal detail is
only logged. Every response carries \`X-Request-Id\`.
`.trim();

export function buildDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Program capacity')
    .setDescription(DESCRIPTION)
    .setVersion(packageVersion())
    .addServer('/', 'This server')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'jwt')
    .addSecurityRequirements('jwt')
    .addTag('Programs', 'Reserve capacity, read availability, list reservations.')
    .addTag('Reservations', 'Release a reservation on repayment.')
    .build();
  return SwaggerModule.createDocument(app, config, {
    operationIdFactory: (_controller, method) => method,
  });
}

// The swagger-ui-dist files the page loads, served by name from this list only (the ingrid pattern).
// Not SwaggerModule.setup: that serves the whole package directory, so /docs/package.json,
// /docs/README.md and every bundle variant answered too. Here anything else under /docs/ is a 404.
const require = createRequire(import.meta.url);
const SWAGGER_FILES = {
  'swagger-ui.css': require.resolve('swagger-ui-dist/swagger-ui.css'),
  'favicon-32x32.png': require.resolve('swagger-ui-dist/favicon-32x32.png'),
  'swagger-ui-bundle.js': require.resolve('swagger-ui-dist/swagger-ui-bundle.js'),
  'swagger-ui-standalone-preset.js': require.resolve('swagger-ui-dist/swagger-ui-standalone-preset.js'),
} as const;
type SwaggerFile = keyof typeof SWAGGER_FILES;
const isSwaggerFile = (name: string): name is SwaggerFile => Object.hasOwn(SWAGGER_FILES, name);

/** Every path under /docs/, so the browser's Basic credentials for the page cover each one. */
const asset = (name: SwaggerFile | typeof INIT_FILE): string => `/docs/${name}`;
const INIT_FILE = 'swagger-ui-init.js';

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Program capacity API</title>
    <link rel="stylesheet" href="${asset('swagger-ui.css')}" />
    <link rel="icon" type="image/png" href="${asset('favicon-32x32.png')}" sizes="32x32" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${asset('swagger-ui-bundle.js')}"></script>
    <script src="${asset('swagger-ui-standalone-preset.js')}"></script>
    <script src="${asset(INIT_FILE)}"></script>
  </body>
</html>
`;

/**
 * The document is embedded in the init script rather than fetched from /openapi.json: the browser only
 * resends the page's Basic credentials for paths under /docs/, so a fetch to /openapi.json could prompt
 * again. `<` is escaped so no string in the spec can end the script.
 */
const initScript = (document: OpenAPIObject): string => {
  const options = JSON.stringify({
    spec: document,
    dom_id: '#swagger-ui',
    layout: 'StandaloneLayout',
    persistAuthorization: true,
    tryItOutEnabled: true,
    displayRequestDuration: true,
  }).replace(/</g, '\\u003c');
  return `window.ui = SwaggerUIBundle(Object.assign(${options}, {
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
}));
`;
};

/**
 * Swagger UI at /docs and the document at /openapi.json, both behind the same JWT as the API.
 * These routes sit on the Express instance, outside Nest's guards, so the docs-auth middleware is mounted
 * first and covers every docs path.
 */
export function setupDocs(app: INestApplication, config: Config, verifier: TokenVerifier): void {
  if (!config.apiDocs) {
    return;
  }
  app.use(docsAuth(verifier));
  const document = buildDocument(app);
  const init = initScript(document);
  const server = app.getHttpAdapter().getInstance() as Express;

  server.get(['/docs', '/docs/'], (_req, res) => {
    res.type('html').send(PAGE);
  });
  server.get('/openapi.json', (_req, res) => {
    res.json(document);
  });
  server.get('/docs/:file', (req, res, next) => {
    const { file } = req.params;
    if (file === INIT_FILE) {
      res.type('js').send(init);
      return;
    }
    if (!isSwaggerFile(file)) {
      next();
      return;
    }
    // dotfiles: pnpm keeps packages under node_modules/.pnpm/, which send() would otherwise refuse.
    // Safe: the path comes from SWAGGER_FILES, never from the request.
    res.sendFile(SWAGGER_FILES[file], { maxAge: '1d', dotfiles: 'allow' });
  });
}
