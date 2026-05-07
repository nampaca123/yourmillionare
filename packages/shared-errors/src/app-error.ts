// Shared error base: AppError and HTTP-mapped subclasses used across all apps.

const SERVER_ERROR_THRESHOLD = 500;

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly userMessage: string,
    logMessage?: string,
  ) {
    super(logMessage ?? userMessage);
    this.name = new.target.name;
  }
}

export class UnauthorizedError extends AppError {
  constructor(logMessage?: string) {
    super(401, 'UNAUTHORIZED', 'Authentication required.', logMessage);
  }
}

export class ForbiddenError extends AppError {
  constructor(logMessage?: string) {
    super(403, 'FORBIDDEN', 'You do not have permission to perform this action.', logMessage);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, logMessage?: string) {
    super(404, 'NOT_FOUND', `${resource} not found.`, logMessage);
  }
}

export class ConflictError extends AppError {
  constructor(logMessage?: string) {
    super(409, 'CONFLICT', 'A conflict occurred with the current state of the resource.', logMessage);
  }
}

export class ValidationError extends AppError {
  constructor(logMessage?: string) {
    super(422, 'VALIDATION_ERROR', 'Request validation failed.', logMessage);
  }
}

export const isServerError = (err: AppError): boolean => err.statusCode >= SERVER_ERROR_THRESHOLD;
