// Client: sends classify task messages to the SQS ClassifyTasksQueue in batches.

import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { AppError } from '@ym/shared-errors';

const QUEUE_URL = process.env.CLASSIFY_QUEUE_URL ?? '';
const MAX_BATCH_SIZE = 10;
const REGION = process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2';

const sqsClient = new SQSClient({ region: REGION });

export interface ClassifyTask {
  rawTransactionId: string;
  tenantId: string;
  syncRunId: string | null;
}

export const sendTaskBatch = async (tasks: ClassifyTask[]): Promise<void> => {
  if (tasks.length === 0) return;

  for (let i = 0; i < tasks.length; i += MAX_BATCH_SIZE) {
    const chunk = tasks.slice(i, i + MAX_BATCH_SIZE);
    const entries = chunk.map((task, idx) => ({
      Id: `${idx}`,
      MessageBody: JSON.stringify(task),
    }));

    const result = await sqsClient.send(
      new SendMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: entries }),
    );

    if (result.Failed && result.Failed.length > 0) {
      const failedIds = result.Failed.map((f) => f.Id).join(', ');
      throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.', `SQS batch send failed for message ids: ${failedIds}`);
    }
  }
};
