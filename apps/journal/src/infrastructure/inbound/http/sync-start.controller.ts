// Controller: POST /tenants/{tenantId}/sync — triggers per-tenant ManualSyncStateMachine.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { StartTenantSyncUseCase } from '../../../application/start-tenant-sync.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';

export const buildSyncStartController =
  (ensureUser: EnsureUserExistsUseCase, startSync: StartTenantSyncUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const idempotencyKey = event.headers?.['idempotency-key'] ?? event.headers?.['Idempotency-Key'];

    const result = await startSync.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    return {
      statusCode: 202,
      body: JSON.stringify(result),
    };
  };
