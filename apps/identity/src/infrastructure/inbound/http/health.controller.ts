// Health controller: unauthenticated liveness probe. No DB ping to prevent ACU abuse.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

export const healthController = (_event: APIGatewayProxyEventV2WithJWTAuthorizer): APIGatewayProxyResultV2 => ({
  statusCode: 200,
  body: JSON.stringify({ status: 'ok' }),
});
