// Idempotency errors: key reuse and in-progress conflicts.

import { AppError } from './app-error.js';

export class IdempotencyKeyReusedError extends AppError {
  constructor(logMessage?: string) {
    super(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency-Key was already used with a different request body.',
      logMessage,
    );
  }
}

export class IdempotencyInProgressError extends AppError {
  constructor(logMessage?: string) {
    super(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'A previous request with this Idempotency-Key is still being processed.',
      logMessage,
    );
  }
}
