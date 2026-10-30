import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { log } from './logger.js';

const REQUEST_ID = /^[\w.-]{1,128}$/;

export interface RequestContext {
  requestId: string;
  /** JWT `sub`, once authenticated. */
  subject?: string;
  /** One word for the log line; set by handlers and the exception filter. */
  outcome?: string;
  programId?: string;
}

export const contextOf = (res: Response): RequestContext => res.locals as RequestContext;

const outcomeFor = (status: number): string =>
  status < 300
    ? 'ok'
    : status === 401
      ? 'unauthenticated'
      : status === 404
        ? 'not_found'
        : status < 500
          ? 'invalid'
          : 'error';

/**
 * Express middleware, first in the chain: assigns the request id (the caller's if well-formed),
 * echoes it as X-Request-Id, and writes exactly one log line when the response finishes.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  const incoming = req.header('x-request-id');
  const ctx = contextOf(res);
  ctx.requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', ctx.requestId);
  res.on('finish', () => {
    log(res.statusCode >= 500 ? 'error' : 'info', 'request', {
      requestId: ctx.requestId,
      method: req.method,
      route:
        (req.route as { path?: string } | undefined)?.path ?? req.baseUrl + (req.route ? '' : 'unmatched'),
      status: res.statusCode,
      durationMs: Number((process.hrtime.bigint() - started) / 1000n) / 1000,
      outcome: ctx.outcome ?? outcomeFor(res.statusCode),
      programId: ctx.programId,
      sub: ctx.subject,
    });
  });
  next();
}
