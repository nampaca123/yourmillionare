// Barrel export for @ym/shared-errors.

export {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  isServerError,
} from './app-error.js';

export { RateLimitError } from './rate-limit.error.js';
export { IdempotencyKeyReusedError, IdempotencyInProgressError } from './idempotency.errors.js';
export { toHttpErrorResponse } from './http-error.js';
export type { HttpErrorResponse } from './http-error.js';
