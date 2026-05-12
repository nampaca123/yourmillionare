// Port: start a Step Functions execution targeted at a single tenant (ManualSyncStateMachine).

export interface SyncDispatcher {
  start(input: {
    tenantId: string;
    syncRunId: string;
    idempotencyKey?: string;
  }): Promise<{ executionArn: string; startDate: string }>;
}
