// Rate limit error: daily call quota exceeded.

import { AppError } from './app-error.js';

export class RateLimitError extends AppError {
  constructor(code = 'RATE_LIMITED', userMessage = 'Daily call limit reached. Try again tomorrow.', logMessage?: string) {
    super(429, code, userMessage, logMessage);
  }
}
