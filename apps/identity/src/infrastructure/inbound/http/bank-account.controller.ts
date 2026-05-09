// Controller: POST /tenants/{tenantId}/bank-accounts — registers a bank account for CODEF collection.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { AddBankAccountUseCase } from '../../../application/add-bank-account.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';
import { AddBankAccountBodySchema } from './bank-account.schema.js';
import { ValidationError } from '../../../shared/errors/app-error.js';

export const buildAddBankAccountController =
  (ensureUser: EnsureUserExistsUseCase, addBankAccount: AddBankAccountUseCase) =>
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

    const parsed = AddBankAccountBodySchema.safeParse(body);
    if (!parsed.success) throw new ZodError(parsed.error.issues);

    const account = await addBankAccount.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      organization: parsed.data.organization,
      accountNumber: parsed.data.accountNumber,
    });

    return {
      statusCode: 201,
      body: JSON.stringify({
        id: account.id,
        tenantId: account.tenantId,
        organization: account.organization,
        accountNumber: account.accountNumber,
        isActive: account.isActive,
      }),
    };
  };
