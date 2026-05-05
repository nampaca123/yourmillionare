// Health controller: unauthenticated liveness probe. No DB ping to prevent ACU abuse.

import type { APIGatewayProxyResultV2 } from 'aws-lambda';

export const healthController = (): APIGatewayProxyResultV2 => ({
  statusCode: 200,
  body: JSON.stringify({ status: 'ok' }),
});
