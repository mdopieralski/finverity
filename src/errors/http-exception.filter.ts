import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';

import { log } from '../logging/logger.js';
import { contextOf } from '../logging/request-context.js';
import { DomainError, ERROR_TABLE, type ErrorKind, errorBody } from './error-table.js';

// Postgres / network errors that mean "the database is not there right now", not "we have a bug".
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

/** Maps everything thrown to the error table. Only constant messages leave; detail goes to the log. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const ctx = contextOf(res);
    const { kind, fields } = this.classify(exception);
    const entry = ERROR_TABLE[kind];
    ctx.outcome = entry.outcome;
    if (entry.status >= 500) {
      const err = exception as { message?: unknown; code?: unknown; stack?: unknown };
      log('error', 'request failed', {
        requestId: ctx.requestId,
        kind,
        error: String(err?.message ?? exception),
        code: err?.code,
        stack: typeof err?.stack === 'string' ? err.stack.split('\n').slice(0, 6).join(' | ') : undefined,
      });
    }
    if (kind === 'unauthenticated') {
      res.setHeader('WWW-Authenticate', 'Bearer');
    }
    res.status(entry.status).json(errorBody(kind, ctx.requestId, fields));
  }

  private classify(exception: unknown): { kind: ErrorKind; fields: string[] } {
    if (exception instanceof DomainError) {
      return { kind: exception.kind, fields: exception.fields };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // Nest's own: unknown route (404), body-parser failures (400 malformed JSON, 413 too large).
      if (status === 404) {
        return { kind: 'route_not_found', fields: [] };
      }
      if (status >= 400 && status < 500) {
        return { kind: 'invalid_request', fields: [] };
      }
    }
    const e = exception as { type?: unknown; status?: unknown; code?: unknown };
    if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
      return { kind: 'invalid_request', fields: [] }; // raw body-parser errors
    }
    if (typeof e?.code === 'string' && UNAVAILABLE_CODES.has(e.code)) {
      return { kind: 'service_unavailable', fields: [] };
    }
    return { kind: 'internal', fields: [] };
  }
}
