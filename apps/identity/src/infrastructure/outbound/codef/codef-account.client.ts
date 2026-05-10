// Client: calls CODEF account/create + account-list for connected ID issuance and account discovery.

import { AppError } from '@ym/shared-errors';

const CODEF_API_BASE = 'https://development.codef.io';
const ACCOUNT_CREATE_PATH = '/v1/account/create';
const SHINHAN_ACCOUNT_LIST_PATH = '/v1/kr/bank/p/account/account-list';
const CODEF_SUCCESS_CODE = 'CF-00000';

export interface DiscoveredAccount {
  accountNumber: string;
  accountName: string;
  balance: string;
}

export interface CreateAccountParams {
  token: string;
  organization: string;
  loginId: string;
  encryptedPassword: string;
  birthDate?: string;
}

interface CodefAccountCreateResponse {
  result: { code: string; message: string; extraMessage?: string };
  data?: { connectedId?: string };
}

interface CodefAccountListRow {
  resAccount?: string;
  resAccountName?: string;
  resAccountBalance?: string;
}

interface CodefAccountListResponse {
  result: { code: string; message: string };
  data?: {
    resDepositTrust?: CodefAccountListRow[];
    resLoan?: CodefAccountListRow[];
    resForeignCurrency?: CodefAccountListRow[];
  };
}

const decodeCodef = async <T>(response: Response): Promise<T> => {
  const raw = await response.text();
  return JSON.parse(decodeURIComponent(raw)) as T;
};

export const createCodefAccount = async (params: CreateAccountParams): Promise<string> => {
  const entry: Record<string, string> = {
    countryCode: 'KR',
    businessType: 'BK',
    clientType: 'P',
    organization: params.organization,
    loginType: '1',
    id: params.loginId,
    password: params.encryptedPassword,
  };
  if (params.birthDate) entry['birthDate'] = params.birthDate;

  const response = await fetch(`${CODEF_API_BASE}${ACCOUNT_CREATE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify({ accountList: [entry] }),
  });

  const decoded = await decodeCodef<CodefAccountCreateResponse>(response);

  if (decoded.result.code !== CODEF_SUCCESS_CODE) {
    const extra = decoded.result.extraMessage ?? '';
    const isApproachingLock = ['02', '03', '04'].some((e) => extra.includes(e));
    const userMsg = isApproachingLock
      ? 'Bank login failed. Warning: repeated failures will lock your internet banking account.'
      : 'External service error.';
    throw new AppError(
      502,
      'CODEF_ACCOUNT_ERROR',
      userMsg,
      `CODEF account/create failed: ${decoded.result.code} ${decoded.result.message}`,
    );
  }

  const connectedId = decoded.data?.connectedId;
  if (!connectedId) {
    throw new AppError(
      502,
      'CODEF_ACCOUNT_ERROR',
      'External service error.',
      'CODEF account/create returned no connectedId',
    );
  }
  return connectedId;
};

export const listShinhanAccounts = async (
  token: string,
  connectedId: string,
  organization: string,
): Promise<DiscoveredAccount[]> => {
  const response = await fetch(`${CODEF_API_BASE}${SHINHAN_ACCOUNT_LIST_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ connectedId, organization }),
  });

  const decoded = await decodeCodef<CodefAccountListResponse>(response);

  if (decoded.result.code !== CODEF_SUCCESS_CODE) {
    throw new AppError(
      502,
      'CODEF_API_ERROR',
      'External service error.',
      `CODEF account-list failed: ${decoded.result.code} ${decoded.result.message}`,
    );
  }

  const deposits = decoded.data?.resDepositTrust ?? [];
  return deposits
    .filter((row) => Boolean(row.resAccount))
    .map((row) => ({
      accountNumber: row.resAccount ?? '',
      accountName: row.resAccountName ?? '',
      balance: row.resAccountBalance ?? '0',
    }));
};
