/**
 * Typed domain errors.
 *
 * Every error crossing a boundary carries a stable `code` and a message that is
 * safe to show a customer. Technical detail lives in `internal`, which is logged
 * and never serialised to a response (spec §33: never expose stack traces).
 */

export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'SLOT_TAKEN'
  | 'INVALID_COMBINATION'
  | 'INVENTORY_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'TENANT_NOT_RESOLVED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Detail for logs only. Never included in a response body. */
  readonly internal?: unknown;
  /** Structured payload that IS safe to return (e.g. alternative slots). */
  readonly data?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; internal?: unknown; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? defaultStatus(code);
    this.internal = opts.internal;
    this.data = opts.data;
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
    case 'TENANT_NOT_RESOLVED':
      return 403;
    case 'VALIDATION_FAILED':
    case 'INVALID_COMBINATION':
      return 400;
    case 'CONFLICT':
    case 'SLOT_TAKEN':
    case 'INVENTORY_UNAVAILABLE':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'DEPENDENCY_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}

export const notFound = (what: string) =>
  new AppError('NOT_FOUND', `${what} could not be found.`);

export const forbidden = (internal?: unknown) =>
  // Deliberately vague: distinguishing "exists but forbidden" from "not found"
  // leaks the existence of other tenants' records.
  new AppError('FORBIDDEN', 'You do not have access to this.', { internal });

export const unauthenticated = () =>
  new AppError('UNAUTHENTICATED', 'Please sign in to continue.');

export const conflict = (message: string, data?: Record<string, unknown>) =>
  new AppError('CONFLICT', message, { data });

/**
 * Shape sent to clients. `internal` is structurally absent, not merely omitted,
 * so it cannot be reintroduced by a future spread.
 */
export function toPublicError(err: unknown): {
  code: ErrorCode;
  message: string;
  data?: Record<string, unknown>;
} {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) };
  }
  return {
    code: 'INTERNAL',
    message: 'Something went wrong on our end. Please try again.',
  };
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Postgres exclusion-constraint violation — a resource is already booked. */
export const PG_EXCLUSION_VIOLATION = '23P01';
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';
export const PG_RLS_VIOLATION = '42501';

/**
 * Find the Postgres SQLSTATE behind an error.
 *
 * Walks the `cause` chain: query builders wrap the driver's error in their own,
 * so the code is not on the object that was thrown. Reading only the top level
 * silently misses every constraint violation — which means a customer racing
 * for a slot sees a raw database error instead of "that time has just gone".
 */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;

  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      const code = (current as { code: unknown }).code;
      // SQLSTATE is five characters; ignore Node's string error codes.
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    current = (current as { cause?: unknown })?.cause;
  }
  return undefined;
}
