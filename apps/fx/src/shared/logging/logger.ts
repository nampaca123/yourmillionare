// Structured pino logger for the FX Lambda (request-scoped child loggers attach a requestId).

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'fx' },
});
