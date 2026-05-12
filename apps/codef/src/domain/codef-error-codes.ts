// Domain: CODEF API result codes that we explicitly recognize and map to user-facing messages.

export const CODEF_SUCCESS_CODE = 'CF-00000';

export const CODEF_ERROR_CODES = {
  ACCOUNT_NOT_REGISTERED: 'CF-12056',
  MAINTENANCE_WINDOW: 'CF-03001',
  AUTH_FAILED: 'CF-05001',
  BIRTHDATE_MISMATCH: 'CF-05007',
  RESPONSE_TIMEOUT: 'CF-00301',
} as const;

export type CodefErrorCode = (typeof CODEF_ERROR_CODES)[keyof typeof CODEF_ERROR_CODES];

export const isKnownCodefErrorCode = (code: string): code is CodefErrorCode =>
  (Object.values(CODEF_ERROR_CODES) as readonly string[]).includes(code);
