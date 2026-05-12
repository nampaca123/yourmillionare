// Controllers for the 4 core views + drafts: summary/monthly, receivables (GET/PATCH), accounts/balances, journal/drafts.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { ValidationError } from '@ym/shared-errors';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { GetMonthlySummaryUseCase } from '../../../application/get-monthly-summary.use-case.js';
import type { GetReceivablesUseCase, UpdateReceivableStatusUseCase } from '../../../application/get-receivables.use-case.js';
import type { GetAccountBalancesUseCase } from '../../../application/get-account-balances.use-case.js';
import type { ListDraftsUseCase } from '../../../application/list-drafts.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';

const YmSchema = z.object({ ym: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });
const ReceivableStatusSchema = z.object({
  status: z.enum(['PENDING', 'DUE_SOON', 'OVERDUE', 'COLLECTED']),
  collectedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const todayIso = (): string => new Date().toISOString().slice(0, 10);

export const buildMonthlySummaryController =
  (ensureUser: EnsureUserExistsUseCase, useCase: GetMonthlySummaryUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';

    const parsed = YmSchema.safeParse(event.queryStringParameters ?? {});
    if (!parsed.success) throw new ZodError(parsed.error.issues);

    const summary = await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      ym: parsed.data.ym,
    });
    return { statusCode: 200, body: JSON.stringify(summary) };
  };

export const buildReceivablesController =
  (ensureUser: EnsureUserExistsUseCase, useCase: GetReceivablesUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';

    const board = await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      today: todayIso(),
    });
    return { statusCode: 200, body: JSON.stringify(board) };
  };

export const buildUpdateReceivableController =
  (ensureUser: EnsureUserExistsUseCase, useCase: UpdateReceivableStatusUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const entryId = event.pathParameters?.entryId ?? '';

    if (!event.body) throw new ValidationError('Request body is required');
    let body: unknown;
    try {
      body = JSON.parse(event.body);
    } catch {
      throw new ValidationError('Body is not valid JSON');
    }
    const parsed = ReceivableStatusSchema.safeParse(body);
    if (!parsed.success) throw new ZodError(parsed.error.issues);

    await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      entryId,
      status: parsed.data.status,
      ...(parsed.data.collectedAt ? { collectedAt: parsed.data.collectedAt } : {}),
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  };

export const buildAccountBalancesController =
  (ensureUser: EnsureUserExistsUseCase, useCase: GetAccountBalancesUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';

    const balances = await useCase.execute({ tenantId, userId: user.id, cognitoSub: claims.cognitoSub });
    return { statusCode: 200, body: JSON.stringify({ balances }) };
  };

export const buildListDraftsController =
  (ensureUser: EnsureUserExistsUseCase, useCase: ListDraftsUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';

    const drafts = await useCase.execute({ tenantId, userId: user.id, cognitoSub: claims.cognitoSub });
    return { statusCode: 200, body: JSON.stringify({ drafts }) };
  };
