// SFN start-execution adapter for the per-tenant ManualSyncStateMachine.

import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { ValidationError } from '@ym/shared-errors';
import type { SyncDispatcher } from '../../../application/ports/sync-dispatcher.port.js';

export class SfnSyncDispatcher implements SyncDispatcher {
  private readonly client: SFNClient;
  private readonly stateMachineArn: string;

  constructor(arn?: string, region?: string) {
    this.stateMachineArn = arn ?? process.env.MANUAL_SYNC_STATE_MACHINE_ARN ?? '';
    this.client = new SFNClient({
      region: region ?? process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2',
    });
  }

  async start(input: {
    tenantId: string;
    syncRunId: string;
    idempotencyKey?: string;
  }): Promise<{ executionArn: string; startDate: string }> {
    if (!this.stateMachineArn) {
      throw new ValidationError('MANUAL_SYNC_STATE_MACHINE_ARN env is not configured');
    }
    const command = new StartExecutionCommand({
      stateMachineArn: this.stateMachineArn,
      input: JSON.stringify({
        tenantId: input.tenantId,
        syncRunId: input.syncRunId,
        triggeredBy: 'manual',
      }),
      ...(input.idempotencyKey
        ? { name: `manual-${input.tenantId}-${input.idempotencyKey.slice(0, 30)}` }
        : {}),
    });
    const response = await this.client.send(command);
    return {
      executionArn: response.executionArn ?? '',
      startDate: (response.startDate ?? new Date()).toISOString(),
    };
  }
}
