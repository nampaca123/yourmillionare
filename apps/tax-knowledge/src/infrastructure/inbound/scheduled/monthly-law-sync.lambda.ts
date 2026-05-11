// Lambda entry: monthly OPEN_LAW corpus sync orchestrator (cron 03:00 KST 1st of month) — drives the LegalSyncStateMachine.

export const handler = async (): Promise<{ ok: boolean; pending: string }> => ({
  ok: true,
  pending:
    'Wave-5: hand off to LegalSyncStateMachine — list TARGET_LAW_REGISTRY, diff MST, fetch/chunks, S3 upload, KB IngestionJob, review gate',
});
