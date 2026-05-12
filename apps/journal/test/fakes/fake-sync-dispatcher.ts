// In-memory SyncDispatcher that records calls and returns a deterministic execution ARN.

import type { SyncDispatcher } from '../../src/application/ports/sync-dispatcher.port.js';

export class FakeSyncDispatcher implements SyncDispatcher {
  public calls: { tenantId: string; syncRunId: string; idempotencyKey?: string }[] = [];
  private counter = 0;

  async start(input: {
    tenantId: string;
    syncRunId: string;
    idempotencyKey?: string;
  }): Promise<{ executionArn: string; startDate: string }> {
    this.calls.push(input);
    this.counter += 1;
    return {
      executionArn: `arn:aws:states:test:000000000000:execution:test:${this.counter}`,
      startDate: new Date('2026-05-12T00:00:00Z').toISOString(),
    };
  }
}
