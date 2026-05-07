// Unit tests for toHttpErrorResponse mapping.

import { describe, it, expect } from 'vitest';
import { ZodError, z } from 'zod';
import {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  IdempotencyKeyReusedError,
  IdempotencyInProgressError,
  toHttpErrorResponse,
} from '../src/index.js';

const ctx = { path: '/test', requestId: 'req-1' };

describe('toHttpErrorResponse', () => {
  it('should return 422 when ZodError', () => {
    const err = z.string().safeParse(123).error as ZodError;

    const result = toHttpErrorResponse(err, ctx);

    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should map AppError statusCode and code', () => {
    const err = new UnauthorizedError('token expired');

    const result = toHttpErrorResponse(err, ctx);

    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('UNAUTHORIZED');
  });

  it('should return 500 fallback for unknown errors', () => {
    const result = toHttpErrorResponse(new Error('boom'), ctx);

    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('should map RateLimitError to 429', () => {
    const err = new RateLimitError('BEDROCK_DAILY_LIMIT_EXCEEDED', 'Daily Bedrock call limit reached.');

    const result = toHttpErrorResponse(err, ctx);

    expect(result.status).toBe(429);
    expect(result.body.error.code).toBe('BEDROCK_DAILY_LIMIT_EXCEEDED');
  });

  it('should map IdempotencyKeyReusedError to 409', () => {
    const result = toHttpErrorResponse(new IdempotencyKeyReusedError(), ctx);

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('should map IdempotencyInProgressError to 409', () => {
    const result = toHttpErrorResponse(new IdempotencyInProgressError(), ctx);

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
  });

  it('should map ConflictError to 409 with CONFLICT code', () => {
    const err = new ConflictError('some conflict happened');

    const result = toHttpErrorResponse(err, ctx);

    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('CONFLICT');
  });

  it('should map ForbiddenError to 403', () => {
    const result = toHttpErrorResponse(new ForbiddenError(), ctx);

    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('FORBIDDEN');
  });

  it('should map NotFoundError to 404 with resource name', () => {
    const result = toHttpErrorResponse(new NotFoundError('Tenant'), ctx);

    expect(result.status).toBe(404);
    expect(result.body.error.message).toBe('Tenant not found.');
  });

  it('should map ValidationError to 422', () => {
    const result = toHttpErrorResponse(new ValidationError(), ctx);

    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe('VALIDATION_ERROR');
  });
});
