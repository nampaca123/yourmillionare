// Structured logger with PII redaction; requestId bound per-request via child().

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.bizRegNo',
      '*.password',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
});
