// Controllers for the 4 financial-statement endpoints (P&L / Balance Sheet / Cash Flow / Trial Balance).

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type {
  BuildBalanceSheetUseCase,
  BuildCashFlowUseCase,
  BuildIncomeStatementUseCase,
  BuildTrialBalanceUseCase,
} from '../../../application/build-reports.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';

const RangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const AsOfSchema = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const CashFlowSchema = RangeSchema.extend({ method: z.enum(['indirect']).default('indirect') });

const parseQuery = <T>(schema: z.ZodTypeAny, query: unknown): T => {
  const parsed = schema.safeParse(query);
  if (!parsed.success) throw new ZodError(parsed.error.issues);
  return parsed.data as T;
};

export const buildPnlController =
  (ensureUser: EnsureUserExistsUseCase, useCase: BuildIncomeStatementUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const q = parseQuery<{ from: string; to: string }>(RangeSchema, event.queryStringParameters ?? {});
    const result = await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      fromDate: q.from,
      toDate: q.to,
    });
    return { statusCode: 200, body: JSON.stringify(result) };
  };

export const buildBalanceSheetController =
  (ensureUser: EnsureUserExistsUseCase, useCase: BuildBalanceSheetUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const q = parseQuery<{ asOf: string }>(AsOfSchema, event.queryStringParameters ?? {});
    const result = await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      asOf: q.asOf,
    });
    return { statusCode: 200, body: JSON.stringify(result) };
  };

export const buildTrialBalanceController =
  (ensureUser: EnsureUserExistsUseCase, useCase: BuildTrialBalanceUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const q = parseQuery<{ asOf: string }>(AsOfSchema, event.queryStringParameters ?? {});
    const result = await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      asOf: q.asOf,
    });
    return { statusCode: 200, body: JSON.stringify(result) };
  };

export const buildCashFlowController =
  (ensureUser: EnsureUserExistsUseCase, useCase: BuildCashFlowUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const q = parseQuery<{ from: string; to: string; method: 'indirect' }>(CashFlowSchema, event.queryStringParameters ?? {});
    const result = await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      fromDate: q.from,
      toDate: q.to,
    });
    return { statusCode: 200, body: JSON.stringify(result) };
  };
