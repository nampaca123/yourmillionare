// Port: persists sync_run lifecycle and reads run + per-account outcomes for the user-facing /sync/runs endpoints.

export type SyncRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out';

export type SyncRunAccountOutcome =
  | 'success'
  | 'no_connection'
  | 'codef_error'
  | 'empty_result'
  | 'balance_only';

export interface SyncRunSummary {
  id: string;
  tenantId: string;
  triggeredBy: 'manual' | 'schedule';
  triggeredAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: SyncRunStatus;
  totalAccounts: number;
  successCount: number;
  errorCount: number;
  emptyCount: number;
  userSummary: string | null;
}

export interface SyncRunAccountSummary {
  organization: string;
  accountNumber: string | null;
  outcome: SyncRunAccountOutcome;
  codefErrorCode: string | null;
  codefErrorMessage: string | null;
  userMessage: string | null;
  fetchedCount: number;
  balanceUpdated: boolean;
  recordedAt: string;
}

export interface SyncRunDetail extends SyncRunSummary {
  accounts: SyncRunAccountSummary[];
}

export interface SyncRunRepository {
  create(input: { tenantId: string; triggeredBy: 'manual' | 'schedule' }): Promise<string>;
  setExecutionArn(input: { tenantId: string; syncRunId: string; executionArn: string }): Promise<void>;
  get(input: { tenantId: string; syncRunId: string }): Promise<SyncRunDetail | null>;
  list(input: { tenantId: string; limit: number }): Promise<SyncRunSummary[]>;
  getLatest(input: { tenantId: string }): Promise<SyncRunDetail | null>;
}
