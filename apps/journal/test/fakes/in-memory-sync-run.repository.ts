// In-memory SyncRunRepository for unit tests.

import { randomUUID } from 'node:crypto';
import type {
  SyncRunDetail,
  SyncRunRepository,
  SyncRunSummary,
} from '../../src/application/ports/sync-run.repository.port.js';

interface StoredRun extends SyncRunSummary {
  sfnExecutionArn: string | null;
}

export class InMemorySyncRunRepository implements SyncRunRepository {
  private runs: StoredRun[] = [];

  all(): StoredRun[] {
    return [...this.runs];
  }

  async create({
    tenantId,
    triggeredBy,
  }: {
    tenantId: string;
    triggeredBy: 'manual' | 'schedule';
  }): Promise<string> {
    const id = randomUUID();
    this.runs.push({
      id,
      tenantId,
      triggeredBy,
      triggeredAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      status: 'queued',
      totalAccounts: 0,
      successCount: 0,
      errorCount: 0,
      emptyCount: 0,
      userSummary: null,
      sfnExecutionArn: null,
    });
    return id;
  }

  async setExecutionArn({
    syncRunId,
    executionArn,
  }: {
    tenantId: string;
    syncRunId: string;
    executionArn: string;
  }): Promise<void> {
    const run = this.runs.find((r) => r.id === syncRunId);
    if (run) run.sfnExecutionArn = executionArn;
  }

  async get({
    tenantId,
    syncRunId,
  }: {
    tenantId: string;
    syncRunId: string;
  }): Promise<SyncRunDetail | null> {
    const run = this.runs.find((r) => r.id === syncRunId && r.tenantId === tenantId);
    if (!run) return null;
    return { ...run, accounts: [] };
  }

  async list({ tenantId, limit }: { tenantId: string; limit: number }): Promise<SyncRunSummary[]> {
    return this.runs
      .filter((r) => r.tenantId === tenantId)
      .slice(0, limit)
      .map(({ sfnExecutionArn: _arn, ...summary }) => summary);
  }

  async getLatest({ tenantId }: { tenantId: string }): Promise<SyncRunDetail | null> {
    const latest = [...this.runs].reverse().find((r) => r.tenantId === tenantId);
    if (!latest) return null;
    return { ...latest, accounts: [] };
  }
}
