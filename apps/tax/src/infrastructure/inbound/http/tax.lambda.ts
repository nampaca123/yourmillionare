// Lambda entry point: dispatches Tax HTTP requests to controllers by routeKey.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { container } from '../../../main.js';
import { toHttpErrorResponse } from '@ym/shared-errors';
import { logger } from '../../../shared/logging/logger.js';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const requestId = event.requestContext.requestId;
  const path = event.requestContext.http.path;
  const log = logger.child({ requestId, path });

  try {
    const routeHandler = container.routes[event.routeKey];
    if (!routeHandler) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }),
      };
    }
    return await routeHandler(event);
  } catch (err) {
    log.error({ err }, 'Unhandled error in tax lambda');
    const { status, body } = toHttpErrorResponse(err, { path, requestId });
    return { statusCode: status, body: JSON.stringify(body) };
  }
};
