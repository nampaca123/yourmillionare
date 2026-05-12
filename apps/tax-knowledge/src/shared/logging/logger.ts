// Structured pino logger for the Tax-Knowledge Lambda.

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'tax-knowledge' },
});
