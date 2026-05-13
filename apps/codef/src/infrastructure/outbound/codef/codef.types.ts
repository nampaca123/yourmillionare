// Types: CODEF OAuth and bank transaction API response shapes.

export interface CodefSecret {
  clientId: string;
  clientSecret: string;
  publicKey: string;
}

export interface CodefTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface CodefTxRow {
  resAccountTrDate: string;
  resAccountTrTime?: string;
  resAccountOut: string;
  resAccountIn: string;
  resAfterTranBalance: string;
  resAccountDesc1?: string;
  resAccountDesc2?: string;
  resAccountDesc3?: string;
  resAccountDesc4?: string;
}

export interface CodefTxResponse {
  result: { code: string; message: string };
  data: {
    resAccountBalance?: string;
    resWithdrawalAmt?: string;
    resTrHistoryList: CodefTxRow[];
  };
}

export interface RawBankTransaction {
  externalId: string;
  occurredAt: Date;
  amount: number;
  counterparty?: string;
  rawPayload: CodefTxRow;
}

export interface AccountBalanceSnapshot {
  currentBalanceKrw: number;
  withdrawableKrw: number | null;
  syncedAt: Date;
}

export interface FetchTransactionsResult {
  transactions: RawBankTransaction[];
  balance: AccountBalanceSnapshot | null;
}

export interface RawForeignTransaction {
  externalId: string;
  occurredAt: Date;
  fcyAmount: number;
  counterparty?: string;
  rawPayload: CodefTxRow;
}

export interface ForeignAccountBalanceSnapshot {
  currentBalanceFcy: number;
  syncedAt: Date;
}

export interface FetchForeignTransactionsResult {
  transactions: RawForeignTransaction[];
  balance: ForeignAccountBalanceSnapshot | null;
}
