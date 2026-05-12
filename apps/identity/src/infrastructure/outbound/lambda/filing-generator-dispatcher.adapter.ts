// Adapter: async-invokes the FilingObligationGeneratorFn lambda right after a personal tenant is provisioned.

import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import type { ObligationSeedDispatcher } from '../../../application/ports/obligation-seed-dispatcher.port.js';
import { logger } from '../../../shared/logging/logger.js';

export class LambdaFilingGeneratorDispatcher implements ObligationSeedDispatcher {
  private readonly client: LambdaClient;
  private readonly functionName: string;

  constructor(functionName?: string, region?: string) {
    this.functionName = functionName ?? process.env.FILING_GENERATOR_FN_NAME ?? '';
    this.client = new LambdaClient({
      region: region ?? process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2',
    });
  }

  async seed({ tenantId }: { tenantId: string }): Promise<void> {
    if (!this.functionName) {
      logger.warn({ tenantId }, 'FILING_GENERATOR_FN_NAME not set — skipping filing obligation auto-seed');
      return;
    }
    try {
      await this.client.send(
        new InvokeCommand({
          FunctionName: this.functionName,
          InvocationType: InvocationType.Event,
          Payload: Buffer.from(JSON.stringify({ tenantId })),
        }),
      );
      logger.info({ tenantId, functionName: this.functionName }, 'Filing obligation seed dispatched');
    } catch (err) {
      logger.warn({ err, tenantId }, 'Failed to dispatch filing obligation seed (non-fatal)');
    }
  }
}
