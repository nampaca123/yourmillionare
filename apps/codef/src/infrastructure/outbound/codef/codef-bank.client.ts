// Client: calls CODEF /v1/kr/bank/p/account/transaction-list and maps to RawBankTransaction[].

import { AppError } from '@ym/shared-errors';
import type { CodefTxResponse, RawBankTransaction } from './codef.types.js';
import { getAccessToken } from './codef-auth.client.js';

const CODEF_API_BASE = 'https://development.codef.io';
const TRANSACTION_LIST_PATH = '/v1/kr/bank/p/account/transaction-list';

const CODEF_SUCCESS_CODE = 'CF-00000';

const parseKrwAmount = (raw: string): number => {
  const n = parseInt(raw.replace(/,/g, ''), 10);
  return isNaN(n) ? 0 : n;
};

const toDate = (date: string, time?: string): Date => {
  const y = date.slice(0, 4);
  const mo = date.slice(4, 6);
  const d = date.slice(6, 8);
  const h = time ? time.slice(0, 2) : '00';
  const mi = time ? time.slice(2, 4) : '00';
  const s = time ? time.slice(4, 6) : '00';
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`);
};

export const fetchTransactions = async (params: {
  connectedId: string;
  organization: string;
  accountNumber: string;
  startDate: string;
  endDate: string;
}): Promise<RawBankTransaction[]> => {
  const token = await getAccessToken();

  const body = JSON.stringify({
    connectedId: params.connectedId,
    organization: params.organization,
    account: params.accountNumber,
    startDate: params.startDate,
    endDate: params.endDate,
    orderBy: '0',
    inquiryType: '1',
  });

  const response = await fetch(`${CODEF_API_BASE}${TRANSACTION_LIST_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (!response.ok) {
    throw new AppError(502, 'CODEF_API_ERROR', 'External service error.', `CODEF API HTTP ${response.status}`);
  }

  // CODEF responses are URL-encoded; raw text + decodeURIComponent + JSON.parse is required.
  const data = JSON.parse(decodeURIComponent(await response.text())) as CodefTxResponse;

  if (data.result.code !== CODEF_SUCCESS_CODE) {
    throw new AppError(
      502,
      'CODEF_API_ERROR',
      'External service error.',
      `CODEF API result code ${data.result.code}: ${data.result.message}`,
    );
  }

  const rows = data.data?.resTrHistoryList ?? [];

  return rows.map((row): RawBankTransaction => {
    const date = row.resAccountTrDate;
    const time = row.resAccountTrTime;
    const out = row.resAccountOut;
    const inAmt = row.resAccountIn;
    const balance = row.resAfterTranBalance;

    const outAmount = parseKrwAmount(out);
    const inAmount = parseKrwAmount(inAmt);
    const amount = inAmount > 0 ? inAmount : -outAmount;

    const externalId = `${date}|${time ?? '000000'}|${out}|${inAmt}|${balance}`;
    const counterparty = row.resAccountDesc1 || row.resAccountDesc2 || undefined;

    return {
      externalId,
      occurredAt: toDate(date, time),
      amount,
      ...(counterparty !== undefined ? { counterparty } : {}),
      rawPayload: row,
    };
  });
};
