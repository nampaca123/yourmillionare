// Maps (organization, codefErrorCode) into Korean user-facing guidance for sync_run_account.user_message.

import { CODEF_ERROR_CODES } from '../domain/codef-error-codes.js';

const ORG_NH = '0011';

const FALLBACK_MESSAGE = (code: string): string =>
  `은행 응답 오류가 발생했습니다. 잠시 후 다시 시도해 주세요. (코드: ${code})`;

export const mapCodefErrorToUserMessage = (organization: string, code: string, raw?: string): string => {
  if (code === CODEF_ERROR_CODES.ACCOUNT_NOT_REGISTERED) {
    if (organization === ORG_NH) {
      return "농협 e-농협 사이트의 '조회계좌관리'에서 본 계좌를 등록 후 다시 시도하세요.";
    }
    return '은행 사이트에서 본 계좌를 조회 가능 계좌로 등록해 주세요.';
  }

  if (code === CODEF_ERROR_CODES.MAINTENANCE_WINDOW) {
    if (organization === ORG_NH) {
      return '농협 점검시간(00:00~00:30)에는 조회 불가, 잠시 후 재시도해 주세요.';
    }
    return '은행 점검시간으로 일시 조회 불가. 잠시 후 재시도해 주세요.';
  }

  if (code === CODEF_ERROR_CODES.AUTH_FAILED || code === CODEF_ERROR_CODES.BIRTHDATE_MISMATCH) {
    return '은행 인증이 만료됐거나 정보가 일치하지 않습니다. 연결을 다시 진행해 주세요.';
  }

  if (code === CODEF_ERROR_CODES.RESPONSE_TIMEOUT) {
    return '은행 응답 지연. 잠시 후 다시 시도해 주세요.';
  }

  return raw && raw.length > 0 && raw.length <= 200 ? raw : FALLBACK_MESSAGE(code);
};

export const NO_CONNECTION_USER_MESSAGE = '은행 연결이 필요합니다. 연결을 먼저 진행해 주세요.';
