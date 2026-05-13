// Port: read-side aggregate for the /uncertain queue (raw_tx + bank account + draft lines + accounts).

export interface UncertainLine {
  readonly lineNo: number;
  readonly accountCode: string;
  readonly accountName: string | null;
  readonly accountType: string | null;
  readonly debit: number;
  readonly credit: number;
  readonly memo: string | null;
}

export interface UncertainItem {
  readonly rawTransactionId: string;
  readonly tenantId: string;
  readonly syncRunId: string | null;
  readonly sourceAccount: {
    readonly bankAccountId: string | null;
    readonly organization: string | null;
    readonly accountNumberMasked: string | null;
  };
  readonly occurredAt: string;
  readonly entryDate: string;
  readonly counterparty: string | null;
  readonly memo: string | null;
  readonly amount: number;
  readonly direction: 'debit' | 'credit';
  readonly currency: string;
  readonly origin: 'heuristic' | 'ai_low_conf';
  readonly confidence: number | null;
  readonly ruleId: string | null;
  readonly lines: ReadonlyArray<UncertainLine>;
  readonly createdAt: string;
}

export interface UncertainRepository {
  list(input: { tenantId: string; limit: number }): Promise<ReadonlyArray<UncertainItem>>;
}
