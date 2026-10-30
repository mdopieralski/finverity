// Typed configuration from the environment. Fails fast at start-up on anything missing or malformed.

export const CONFIG = Symbol('CONFIG');

export interface Config {
  port: number;
  databaseUrl: string;
  dbPoolSize: number;
  jwtSecret: string;
  jwtIssuer: string | undefined;
  jwtAudience: string | undefined;
  kafkaEnabled: boolean;
  kafkaBrokers: string[];
  kafkaTopic: string;
  kafkaGroupId: string;
  apiDocs: boolean;
  /** "FROM/TO=rate" pairs, comma separated, e.g. "USD/EUR=0.909091,EUR/USD=1.1". Empty = built-in table. */
  fxRates: string;
}

const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const int = (name: string, v: string | undefined, fallback: number): number => {
  if (v === undefined || v === '') {
    return fallback;
  }
  if (!/^\d+$/.test(v)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number.parseInt(v, 10);
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) {
      throw new Error(`${name} is required`);
    }
    return v;
  };
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 16) {
    throw new Error('JWT_SECRET must be at least 16 characters');
  }
  return {
    port: int('PORT', env.PORT, 3000),
    databaseUrl: required('DATABASE_URL'),
    dbPoolSize: int('DB_POOL_SIZE', env.DB_POOL_SIZE, 20),
    jwtSecret,
    jwtIssuer: env.JWT_ISSUER || undefined,
    jwtAudience: env.JWT_AUDIENCE || undefined,
    kafkaEnabled: bool(env.KAFKA_ENABLED, true),
    kafkaBrokers: (env.KAFKA_BROKERS ?? 'localhost:19092').split(',').filter(Boolean),
    kafkaTopic: env.KAFKA_TOPIC || 'treasury.capacity.v1',
    kafkaGroupId: env.KAFKA_GROUP_ID || 'program-capacity',
    apiDocs: bool(env.API_DOCS, false),
    fxRates: env.FX_RATES ?? '',
  };
}
