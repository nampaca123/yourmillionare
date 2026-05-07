// Re-exports all error classes from the shared @ym/shared-errors package.

export {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  isServerError,
} from '@ym/shared-errors';
