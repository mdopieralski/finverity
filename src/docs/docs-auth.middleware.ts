import type { NextFunction, Request, Response } from 'express';

import { bearerToken, type TokenVerifier } from '../auth/token-verifier.js';
import { errorBody } from '../errors/error-table.js';
import { contextOf } from '../logging/request-context.js';

/**
 * Every path the docs surface can answer on: Swagger UI, its assets, and the raw document. Matched the
 * way Express routes (case-insensitive, trailing slash optional, percent-decoded), so /DOCS or
 * /openapi.json/ cannot slip past this check while SwaggerModule's routes still answer them.
 */
export function isDocsPath(rawPath: string): boolean {
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    // malformed escapes: judge the raw path
  }
  const p = path.toLowerCase().replace(/\/+$/, '');
  return p === '/docs' || p.startsWith('/docs/') || p.startsWith('/docs-') || p.startsWith('/openapi.');
}

/**
 * The docs are behind the same JWT as the API (decided 2026-10-28). A browser cannot attach a bearer
 * header to a page load, but it prompts for Basic credentials natively and resends them for every
 * asset: so the page takes Basic auth with the JWT as the password (any username). The JSON document
 * also accepts a normal Bearer header. One credential, one signing key, no docs password.
 */
export function docsAuth(verifier: TokenVerifier) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!isDocsPath(req.path)) {
      next();
      return;
    }
    const header = req.header('authorization');
    let token = bearerToken(header);
    const basic = header ? /^Basic ([A-Za-z0-9+/=]+)$/.exec(header) : null;
    if (!token && basic?.[1]) {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      token = decoded.slice(decoded.indexOf(':') + 1);
    }
    const subject = await verifier.subjectOf(token);
    const ctx = contextOf(res);
    if (!subject) {
      ctx.outcome = 'unauthenticated';
      res
        .status(401)
        .setHeader(
          'WWW-Authenticate',
          'Basic realm="API docs: password = a JWT from `pnpm run token`", charset="UTF-8"'
        )
        .json(errorBody('unauthenticated', ctx.requestId));
      return;
    }
    ctx.subject = subject;
    ctx.outcome = 'docs';
    next();
  };
}
