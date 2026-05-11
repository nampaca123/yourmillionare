// Controller: GET /accounts/chart — returns the K-IFRS default chart of accounts (unauthenticated, static).

import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { K_IFRS_DEFAULT_ACCOUNTS } from '@ym/journal-core';

const CACHE_MAX_AGE_SECONDS = 3_600;

export const accountsChartController = async (): Promise<APIGatewayProxyResultV2> => ({
  statusCode: 200,
  headers: { 'Cache-Control': `public, max-age=${CACHE_MAX_AGE_SECONDS}` },
  body: JSON.stringify({ accounts: K_IFRS_DEFAULT_ACCOUNTS }),
});
