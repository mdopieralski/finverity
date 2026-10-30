import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';

import { DomainError } from '../errors/error-table.js';
import { contextOf } from '../logging/request-context.js';
import { bearerToken, TokenVerifier } from './token-verifier.js';

/**
 * Registered as the global APP_GUARD: every controller route needs `Authorization: Bearer <jwt>`,
 * availability reads included. There is no opt-out decorator. The docs surface is outside Nest's
 * routing and has its own middleware with the same verifier (src/docs/docs-auth.middleware.ts).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(TokenVerifier) private readonly verifier: TokenVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const subject = await this.verifier.subjectOf(bearerToken(req.header('authorization')));
    if (!subject) {
      throw new DomainError('unauthenticated');
    }
    contextOf(http.getResponse<Response>()).subject = subject;
    return true;
  }
}
