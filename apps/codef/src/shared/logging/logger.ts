// Structured logger with PII redaction; bind requestId via child() per invocation.

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      '*.token',
      '*.access_token',
      '*.clientSecret',
      '*.publicKey',
    ],
    censor: '[REDACTED]',
  },
});
