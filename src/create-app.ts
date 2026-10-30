import 'reflect-metadata';

import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule, type AppOverrides } from './app.module.js';
import { TokenVerifier } from './auth/token-verifier.js';
import type { Config } from './config/config.js';
import { setupDocs } from './docs/openapi.js';
import { requestContext } from './logging/request-context.js';

/**
 * The composition root, shared by main.ts, the tests and the OpenAPI export. Creates the app without
 * touching the network: the pool connects lazily, the Kafka consumer starts on init (if enabled).
 */
export async function createApp(config: Config, overrides: AppOverrides = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, overrides), {
    logger: new ConsoleLogger({ json: true, logLevels: ['warn', 'error', 'fatal'] }),
    abortOnError: false,
  });
  app.disable('x-powered-by');
  app.use(requestContext);
  setupDocs(app, config, app.get(TokenVerifier));
  app.enableShutdownHooks();
  return app;
}
