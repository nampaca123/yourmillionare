// Unit tests for the CODEF error message mapper used by sync_run_account.user_message.

import { describe, it, expect } from 'vitest';
import {
  NO_CONNECTION_USER_MESSAGE,
  mapCodefErrorToUserMessage,
} from '../src/application/codef-error-messages.js';
import { CODEF_ERROR_CODES } from '../src/domain/codef-error-codes.js';

const ORG_NH = '0011';
const ORG_SHINHAN = '0088';

describe('mapCodefErrorToUserMessage', () => {
  it('should return NH-specific guidance when account is not registered for NH', () => {
    const message = mapCodefErrorToUserMessage(ORG_NH, CODEF_ERROR_CODES.ACCOUNT_NOT_REGISTERED);

    expect(message).toContain('농협');
    expect(message).toContain('조회계좌관리');
  });

  it('should return generic registration guidance when account is not registered for non-NH', () => {
    const message = mapCodefErrorToUserMessage(ORG_SHINHAN, CODEF_ERROR_CODES.ACCOUNT_NOT_REGISTERED);

    expect(message).not.toContain('농협');
    expect(message).toContain('조회 가능 계좌');
  });

  it('should return NH maintenance window guidance during 00:00~00:30', () => {
    const message = mapCodefErrorToUserMessage(ORG_NH, CODEF_ERROR_CODES.MAINTENANCE_WINDOW);

    expect(message).toContain('농협');
    expect(message).toContain('00:00~00:30');
  });

  it('should return auth-failure guidance for CF-05001', () => {
    const message = mapCodefErrorToUserMessage(ORG_SHINHAN, CODEF_ERROR_CODES.AUTH_FAILED);

    expect(message).toContain('인증');
    expect(message).toContain('연결을 다시');
  });

  it('should fall back to a generic message including the unknown code', () => {
    const message = mapCodefErrorToUserMessage(ORG_SHINHAN, 'CF-99999');

    expect(message).toContain('CF-99999');
  });

  it('should prefer raw bank-provided message when reasonably short and code is unknown', () => {
    const message = mapCodefErrorToUserMessage(ORG_SHINHAN, 'CF-99999', '계좌 일시 잠금');

    expect(message).toBe('계좌 일시 잠금');
  });

  it('should expose the standard no-connection message as a constant', () => {
    expect(NO_CONNECTION_USER_MESSAGE).toContain('연결');
  });
});
