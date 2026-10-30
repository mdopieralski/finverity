import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { CONFIG, type Config } from '../config/config.js';

/** Verifies HS256 JWTs signed with JWT_SECRET. Every route and the docs use this one verifier. */
@Injectable()
export class TokenVerifier {
  private readonly jwt: JwtService;

  constructor(@Inject(CONFIG) private readonly config: Config) {
    this.jwt = new JwtService({ secret: config.jwtSecret });
  }

  /**
   * The token's `sub`, or null for anything invalid: bad signature, expired, wrong iss/aud, no sub, or no
   * `exp`. jsonwebtoken accepts a token without `exp` forever, so its presence is checked here.
   */
  async subjectOf(token: string | undefined): Promise<string | null> {
    if (!token) {
      return null;
    }
    try {
      const claims = await this.jwt.verifyAsync<{ sub?: unknown; exp?: unknown }>(token, {
        algorithms: ['HS256'],
        ...(this.config.jwtIssuer ? { issuer: this.config.jwtIssuer } : {}),
        ...(this.config.jwtAudience ? { audience: this.config.jwtAudience } : {}),
      });
      if (typeof claims.exp !== 'number') {
        return null;
      }
      return typeof claims.sub === 'string' && claims.sub.length > 0 && claims.sub.length <= 200
        ? claims.sub
        : null;
    } catch {
      return null;
    }
  }
}

export const bearerToken = (header: string | undefined): string | undefined => {
  const m = header ? /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header) : null;
  return m?.[1];
};
