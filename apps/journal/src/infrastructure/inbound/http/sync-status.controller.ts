// Controller: GET /tenants/{tenantId}/sync/status — returns ingestion progress aggregates.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { GetSyncStatusUseCase } from '../../../application/get-sync-status.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';

export const buildSyncStatusController =
  (ensureUser: EnsureUserExistsUseCase, getStatus: GetSyncStatusUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';

    const snapshot = await getStatus.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
    });

    return {
      statusCode: 200,
      body: JSON.stringify(snapshot),
    };
  };
