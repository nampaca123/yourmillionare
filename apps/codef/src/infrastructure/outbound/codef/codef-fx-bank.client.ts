// Client: calls CODEF transaction-list for foreign-currency accounts (parses FCY decimals, no KRW conversion).

import type {
  CodefTxResponse,
  CodefTxRow,
  FetchForeignTransactionsResult,
  RawForeignTransaction,
} from './codef.types.js';
import { getAccessToken } from './codef-auth.client.js';
import { CODEF_SUCCESS_CODE } from '../../../domain/codef-error-codes.js';

const CODEF_API_BASE = 'https://development.codef.io';
const TRANSACTION_LIST_PATH = '/v1/kr/bank/p/account/transaction-list';

export type FetchForeignTransactionsOutcome =
  | { ok: true; data: FetchForeignTransactionsResult }
  | { ok: false; code: string; message: string };

const parseFcyAmount = (raw: string | undefined): number => {
  if (!raw) return 0;
  const n = Number.parseFloat(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
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

const buildForeignTransaction = (row: CodefTxRow): RawForeignTransaction => {
  const date = row.resAccountTrDate;
  const time = row.resAccountTrTime;
  const out = row.resAccountOut;
  const inAmt = row.resAccountIn;
  const balance = row.resAfterTranBalance;

  const outAmount = parseFcyAmount(out);
  const inAmount = parseFcyAmount(inAmt);
  const fcyAmount = inAmount > 0 ? inAmount : -outAmount;

  const externalId = `${date}|${time ?? '000000'}|${out}|${inAmt}|${balance}`;
  const counterparty = row.resAccountDesc1 || row.resAccountDesc2 || undefined;

  return {
    externalId,
    occurredAt: toDate(date, time),
    fcyAmount,
    ...(counterparty !== undefined ? { counterparty } : {}),
    rawPayload: row,
  };
};

const buildForeignResult = (data: CodefTxResponse): FetchForeignTransactionsResult => {
  const rows = data.data?.resTrHistoryList ?? [];
  const transactions = rows.map(buildForeignTransaction);

  const balanceRaw =
    data.data?.resAccountBalance ?? (rows.length > 0 ? rows[rows.length - 1]?.resAfterTranBalance : undefined);

  return {
    transactions,
    balance: balanceRaw
      ? {
          currentBalanceFcy: parseFcyAmount(balanceRaw),
          syncedAt: new Date(),
        }
      : null,
  };
};

export const fetchForeignTransactions = async (params: {
  connectedId: string;
  organization: string;
  accountNumber: string;
  startDate: string;
  endDate: string;
}): Promise<FetchForeignTransactionsOutcome> => {
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
    return { ok: false, code: `HTTP-${response.status}`, message: `CODEF API HTTP ${response.status}` };
  }

  const data = JSON.parse(decodeURIComponent(await response.text())) as CodefTxResponse;

  if (data.result.code !== CODEF_SUCCESS_CODE) {
    return { ok: false, code: data.result.code, message: data.result.message };
  }

  return { ok: true, data: buildForeignResult(data) };
};
