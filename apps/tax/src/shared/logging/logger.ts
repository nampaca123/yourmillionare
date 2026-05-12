// Structured pino logger for the Tax Lambda.

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'tax' },
});
