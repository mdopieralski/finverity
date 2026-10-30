// The one table that maps a failure kind to an HTTP status, a FIXED client message and a log outcome.
// Client messages are constant strings so database or upstream detail never reaches a caller.
// The OpenAPI error examples are generated from this table too (src/docs/api-errors.decorator.ts).

export const ERROR_TABLE = {
  unauthenticated: { status: 401, message: 'Authentication required.', outcome: 'unauthenticated' },
  invalid_request: { status: 400, message: 'The request is invalid.', outcome: 'invalid' },
  invalid_amount: {
    status: 400,
    message: 'amountMinor must be a positive integer string in minor units.',
    outcome: 'invalid',
  },
  idempotency_key_required: {
    status: 400,
    message: 'Idempotency-Key header is required (1-255 printable characters).',
    outcome: 'invalid',
  },
  program_not_found: { status: 404, message: 'Program not found.', outcome: 'not_found' },
  reservation_not_found: { status: 404, message: 'Reservation not found.', outcome: 'not_found' },
  route_not_found: { status: 404, message: 'Not found.', outcome: 'not_found' },
  idempotency_key_reused: {
    status: 409,
    message: 'Idempotency-Key was already used with a different request.',
    outcome: 'conflict',
  },
  invoice_already_reserved: {
    status: 409,
    message: 'This invoice already has an active reservation on this program.',
    outcome: 'conflict',
  },
  insufficient_capacity: {
    status: 422,
    message: 'Insufficient capacity on this program.',
    outcome: 'rejected',
  },
  fx_rate_unavailable: {
    status: 422,
    message: 'No exchange rate is available for this currency pair.',
    outcome: 'rejected',
  },
  service_unavailable: { status: 503, message: 'Service temporarily unavailable.', outcome: 'unavailable' },
  internal: { status: 500, message: 'Internal error.', outcome: 'error' },
} as const satisfies Record<string, { status: number; message: string; outcome: string }>;

export type ErrorKind = keyof typeof ERROR_TABLE;

export const isErrorKind = (v: unknown): v is ErrorKind =>
  typeof v === 'string' && Object.hasOwn(ERROR_TABLE, v);

/** A failure with a known kind. Anything else that is thrown becomes `internal`. */
export class DomainError extends Error {
  constructor(
    readonly kind: ErrorKind,
    /** Names of the offending fields (never their values). */
    readonly fields: string[] = []
  ) {
    super(kind);
  }
}

export interface ErrorBody {
  error: { code: ErrorKind; message: string; requestId: string; fields?: string[] };
}

export function errorBody(kind: ErrorKind, requestId: string, fields: string[] = []): ErrorBody {
  return {
    error: {
      code: kind,
      message: ERROR_TABLE[kind].message,
      requestId,
      ...(fields.length ? { fields } : {}),
    },
  };
}
