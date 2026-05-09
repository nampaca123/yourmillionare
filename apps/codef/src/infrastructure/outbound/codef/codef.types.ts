// Types: CODEF OAuth and bank transaction API response shapes.

export interface CodefSecret {
  clientId: string;
  clientSecret: string;
  publicKey: string;
  connectedIds: Record<string, string>;
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
  data: { resTrHistoryList: CodefTxRow[] };
}

export interface RawBankTransaction {
  externalId: string;
  occurredAt: Date;
  amount: number;
  counterparty?: string;
  rawPayload: CodefTxRow;
}
