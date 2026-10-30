// Prints a JWT for the API and for /docs (as the Basic-auth password).
//   pnpm run -s token [-- --sub reviewer --ttl 3600]
// Uses JWT_SECRET from the environment, or the local dev default that docker compose also uses.
import { JwtService } from '@nestjs/jwt';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

const secret = process.env.JWT_SECRET ?? 'dev-only-change-me-0123456789';
const ttl = Number.parseInt(arg('ttl', '3600'), 10);
const token = new JwtService({ secret }).sign(
  { sub: arg('sub', 'reviewer') },
  {
    algorithm: 'HS256',
    expiresIn: ttl,
    ...(process.env.JWT_ISSUER ? { issuer: process.env.JWT_ISSUER } : {}),
    ...(process.env.JWT_AUDIENCE ? { audience: process.env.JWT_AUDIENCE } : {}),
  }
);
process.stdout.write(`${token}\n`);
