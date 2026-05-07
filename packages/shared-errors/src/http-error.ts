// Maps any error into a framework-agnostic HTTP response shape.

import { ZodError } from 'zod';
import pino from 'pino';
import { AppError } from './app-error.js';

const SERVER_ERROR_THRESHOLD = 500;

const FALLBACK = {
  status: 500,
  body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } },
} as const;

export interface HttpErrorResponse {
  status: number;
  body: { error: { code: string; message: string } };
}

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export const toHttpErrorResponse = (
  err: unknown,
  context: { path: string; requestId?: string },
): HttpErrorResponse => {
  if (err instanceof ZodError) {
    logger.child(context).warn({ err }, 'Validation error');
    return { status: 422, body: { error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.' } } };
  }

  if (err instanceof AppError) {
    const level = err.statusCode >= SERVER_ERROR_THRESHOLD ? 'error' : 'warn';
    logger.child(context)[level]({ err }, err.message);
    return {
      status: err.statusCode,
      body: { error: { code: err.code, message: err.userMessage } },
    };
  }

  logger.child(context).error({ err }, 'Unhandled error');
  return FALLBACK;
};
