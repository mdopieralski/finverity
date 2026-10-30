import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { TokenVerifier } from './auth/token-verifier.js';
import { CapacityService } from './capacity/capacity.service.js';
import { CONFIG, type Config } from './config/config.js';
import { createPool, type Db, PG_POOL } from './db/database.js';
import { AllExceptionsFilter } from './errors/http-exception.filter.js';
import { FixedTableFxRateProvider, FX_RATE_PROVIDER, type FxRateProvider } from './fx/fx-rate.provider.js';
import { ProgramsController } from './http/programs.controller.js';
import { ReservationsController } from './http/reservations.controller.js';
import { TreasuryConsumer } from './treasury/treasury.consumer.js';
import { TreasuryHandler } from './treasury/treasury.handler.js';

export interface AppOverrides {
  /** Tests inject a mutable provider to move the rate between reserve and release. */
  fxRateProvider?: FxRateProvider;
}

class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Module({})
export class AppModule {
  static forRoot(config: Config, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      controllers: [ProgramsController, ReservationsController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: PG_POOL, useFactory: () => createPool(config.databaseUrl, config.dbPoolSize) },
        {
          provide: FX_RATE_PROVIDER,
          useFactory: () => overrides.fxRateProvider ?? new FixedTableFxRateProvider(config.fxRates),
        },
        TokenVerifier,
        CapacityService,
        TreasuryHandler,
        TreasuryConsumer,
        PoolCloser,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
      exports: [PG_POOL, TokenVerifier, TreasuryHandler],
    };
  }
}
