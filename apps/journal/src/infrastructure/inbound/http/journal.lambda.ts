// Lambda entry point: dispatches journal requests to controllers by routeKey.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { container, registerJournalPowertoolsContext } from '../../../main.js';
import { toHttpErrorResponse } from '@ym/shared-errors';
import { logger } from '../../../shared/logging/logger.js';

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  registerJournalPowertoolsContext(context);
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
    log.error({ err }, 'Unhandled error in journal lambda');
    const { status, body } = toHttpErrorResponse(err, { path, requestId });
    return { statusCode: status, body: JSON.stringify(body) };
  }
};
