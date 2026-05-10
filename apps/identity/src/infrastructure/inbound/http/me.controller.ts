// ME controller: resolves or creates current user, then auto-provisions a personal tenant.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { EnsurePersonalTenantUseCase } from '../../../application/ensure-personal-tenant.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';

export const buildMeController =
  (ensureUser: EnsureUserExistsUseCase, ensurePersonalTenant: EnsurePersonalTenantUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenant = await ensurePersonalTenant.execute(user);

    return {
      statusCode: 200,
      body: JSON.stringify({
        id: user.id,
        cognitoSub: user.cognitoSub,
        email: user.email,
        defaultTenantId: tenant.id,
      }),
    };
  };
