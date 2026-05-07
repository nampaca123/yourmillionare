// Classify controller: validates input and delegates to ClassifyTransactionUseCase.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { EnsureAccountsSeededUseCase } from '../../../application/ensure-accounts-seeded.use-case.js';
import type { VerifyTenantMembershipUseCase } from '../../../application/verify-tenant-membership.use-case.js';
import type { ClassifyTransactionUseCase } from '../../../application/classify-transaction.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';
import { ClassifyBodySchema } from './classify.schema.js';
import { ValidationError } from '@ym/shared-errors';

export const buildClassifyController =
  (
    ensureUser: EnsureUserExistsUseCase,
    verifyMembership: VerifyTenantMembershipUseCase,
    ensureSeeded: EnsureAccountsSeededUseCase,
    classify: ClassifyTransactionUseCase,
  ) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';

    await verifyMembership.execute({ tenantId, userId: user.id });
    await ensureSeeded.execute({ tenantId, userId: user.id });

    let body: unknown;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      throw new ValidationError('Request body is not valid JSON');
    }

    const parsed = ClassifyBodySchema.safeParse(body);
    if (!parsed.success) throw new ZodError(parsed.error.issues);

    const entry = await classify.execute({ tenantId, userId: user.id, input: parsed.data });

    return {
      statusCode: 201,
      body: JSON.stringify({
        id: entry.id,
        tenantId: entry.tenantId,
        entryDate: entry.entryDate,
        aiConfidence: entry.aiConfidence,
        aiModel: entry.aiModel,
        lines: entry.lines,
      }),
    };
  };
