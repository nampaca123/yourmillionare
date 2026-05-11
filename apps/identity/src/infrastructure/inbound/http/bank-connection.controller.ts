// Controller: POST /tenants/{tenantId}/bank-connections — authenticates with bank via CODEF and lists discovered accounts.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { ConnectBankUseCase } from '../../../application/connect-bank.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';
import { ConnectBankBodySchema } from './bank-connection.schema.js';
import { ValidationError } from '../../../shared/errors/app-error.js';

export const buildConnectBankController =
  (ensureUser: EnsureUserExistsUseCase, connectBank: ConnectBankUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });

    const tenantId = event.pathParameters?.tenantId ?? '';

    let body: unknown;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      throw new ValidationError('Request body is not valid JSON');
    }

    const parsed = ConnectBankBodySchema.safeParse(body);
    if (!parsed.success) throw new ZodError(parsed.error.issues);

    const result = await connectBank.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      organization: parsed.data.organization,
      loginId: parsed.data.loginId,
      loginPassword: parsed.data.loginPassword,
      ...(parsed.data.birthDate !== undefined ? { birthDate: parsed.data.birthDate } : {}),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        connectionId: result.connectionId,
        accounts: result.accounts,
      }),
    };
  };
