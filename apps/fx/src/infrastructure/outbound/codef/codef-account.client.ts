// Client: calls CODEF account-list (보유계좌) and extracts foreign-currency accounts.

import { AppError } from '@ym/shared-errors';

const CODEF_API_BASE = 'https://development.codef.io';
const ACCOUNT_LIST_PATH = '/v1/kr/bank/p/account/account-list';
const CODEF_SUCCESS_CODE = 'CF-00000';

export interface DiscoveredFxAccount {
  accountNumber: string;
  accountDisplay: string;
  accountName: string;
  currency: string;
  balanceFcy: string;
}

interface CodefForeignRow {
  resAccount?: string;
  resAccountDisplay?: string;
  resAccountName?: string;
  resAccountCurrency?: string;
  resAccountBalance?: string;
  resAccountDeposit?: string;
}

interface CodefAccountListResponse {
  result: { code: string; message: string };
  data?: {
    resForeignCurrency?: CodefForeignRow[];
  };
}

const decodeCodef = async <T>(response: Response): Promise<T> => {
  const raw = await response.text();
  return JSON.parse(decodeURIComponent(raw)) as T;
};

export const listForeignAccounts = async (
  token: string,
  connectedId: string,
  organization: string,
): Promise<DiscoveredFxAccount[]> => {
  const response = await fetch(`${CODEF_API_BASE}${ACCOUNT_LIST_PATH}`, {
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

  const rows = decoded.data?.resForeignCurrency ?? [];
  return rows
    .filter((row) => Boolean(row.resAccount) && Boolean(row.resAccountCurrency))
    .map((row) => ({
      accountNumber: row.resAccount ?? '',
      accountDisplay: row.resAccountDisplay ?? row.resAccount ?? '',
      accountName: row.resAccountName ?? '',
      currency: row.resAccountCurrency ?? '',
      balanceFcy: row.resAccountBalance ?? '0',
    }));
};
