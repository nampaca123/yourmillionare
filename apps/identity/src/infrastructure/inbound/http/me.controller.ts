// ME controller: resolve or create current user based on Cognito ID Token claims.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';

export const buildMeController =
  (ensureUser: EnsureUserExistsUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });

    return {
      statusCode: 200,
      body: JSON.stringify({ id: user.id, cognitoSub: user.cognitoSub, email: user.email }),
    };
  };
