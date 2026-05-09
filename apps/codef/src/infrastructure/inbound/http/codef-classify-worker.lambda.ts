// Lambda entry: SQS-triggered classify worker stub (expand with classify-and-record use case).

import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';

export const handler = async (_event: SQSEvent): Promise<SQSBatchResponse> => {
  return { batchItemFailures: [] };
};
