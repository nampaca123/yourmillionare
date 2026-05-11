// Port: per-tenant ingestion progress aggregates (counts + last-event timestamps).

export interface SyncStateSnapshot {
  readonly undispatched: number;
  readonly dispatched: number;
  readonly classified: number;
  readonly lastFetchedAt: string | null;
  readonly lastClassifiedAt: string | null;
}

export interface SyncStateRepository {
  snapshot(input: { tenantId: string }): Promise<SyncStateSnapshot>;
}
