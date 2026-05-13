// Controllers: GET /uncertain, POST /uncertain/{rawTransactionId}/confirm, POST /uncertain/{rawTransactionId}/discard.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { ValidationError } from '@ym/shared-errors';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { ListUncertainUseCase } from '../../../application/list-uncertain.use-case.js';
import type { ConfirmUncertainUseCase } from '../../../application/confirm-uncertain.use-case.js';
import type { DiscardUncertainUseCase } from '../../../application/discard-uncertain.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const CorrectedLineSchema = z.object({
  lineNo: z.number().int().min(1),
  accountCode: z.string().min(1).max(10),
  debit: z.number().nonnegative(),
  credit: z.number().nonnegative(),
  memo: z.string().nullable().optional(),
});

const ConfirmRequestSchema = z
  .object({
    correctedLines: z.array(CorrectedLineSchema).min(2).optional(),
  })
  .strict();

const parseLimit = (raw: string | undefined): number => {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) throw new ValidationError('limit must be a positive integer');
  return Math.min(n, MAX_LIMIT);
};

const parseBody = (raw: string | undefined): unknown => {
  if (raw === undefined || raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('Body is not valid JSON');
  }
};

export const buildListUncertainController =
  (ensureUser: EnsureUserExistsUseCase, useCase: ListUncertainUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const limit = parseLimit(event.queryStringParameters?.limit);

    const items = await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      limit,
    });
    return { statusCode: 200, body: JSON.stringify({ items }) };
  };

export const buildConfirmUncertainController =
  (ensureUser: EnsureUserExistsUseCase, useCase: ConfirmUncertainUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const rawTransactionId = event.pathParameters?.rawTransactionId ?? '';

    if (!rawTransactionId) throw new ValidationError('rawTransactionId is required');

    const parsed = ConfirmRequestSchema.safeParse(parseBody(event.body ?? undefined));
    if (!parsed.success) throw new ZodError(parsed.error.issues);

    const result = await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      rawTransactionId,
      ...(parsed.data.correctedLines ? { correctedLines: parsed.data.correctedLines } : {}),
    });
    return { statusCode: 200, body: JSON.stringify(result) };
  };

export const buildDiscardUncertainController =
  (ensureUser: EnsureUserExistsUseCase, useCase: DiscardUncertainUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const rawTransactionId = event.pathParameters?.rawTransactionId ?? '';

    if (!rawTransactionId) throw new ValidationError('rawTransactionId is required');

    const result = await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      rawTransactionId,
    });
    return { statusCode: 200, body: JSON.stringify(result) };
  };
