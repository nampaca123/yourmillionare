// Controller: POST /tenants/{tenantId}/fx/revalue?asOf=YYYY-MM-DD — month-end IAS 21 revaluation (stub for Wave-5 expansion).

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import type { RevalueForeignBalancesUseCase } from '../../../application/revalue-foreign-balances.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';

const Schema = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export const buildFxRevalueController =
  (useCase: RevalueForeignBalancesUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    parseClaims(event.requestContext.authorizer.jwt.claims);
    const tenantId = event.pathParameters?.tenantId ?? '';
    const parsed = Schema.safeParse(event.queryStringParameters ?? {});
    if (!parsed.success) throw new ZodError(parsed.error.issues);
    const result = await useCase.execute({ tenantId, asOf: parsed.data.asOf });
    return { statusCode: 200, body: JSON.stringify(result) };
  };
