// Controllers for PATCH /entries/{id}, POST /entries/{id}/confirm, POST /entries/{id}/discard.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { ValidationError } from '@ym/shared-errors';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { UpdateEntryLinesUseCase } from '../../../application/update-entry-lines.use-case.js';
import type { ConfirmEntryUseCase } from '../../../application/confirm-entry.use-case.js';
import type { DiscardEntryUseCase } from '../../../application/discard-entry.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';

const LineSchema = z.object({
  lineNo: z.number().int().min(1),
  accountCode: z.string().min(1).max(10),
  debit: z.number().nonnegative(),
  credit: z.number().nonnegative(),
  memo: z.string().nullable().optional(),
});

const PatchBodySchema = z
  .object({
    lines: z.array(LineSchema).min(2),
  })
  .strict();

const parseBody = (raw: string | undefined): unknown => {
  if (raw === undefined || raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('Body is not valid JSON');
  }
};

export const buildPatchEntryController =
  (ensureUser: EnsureUserExistsUseCase, useCase: UpdateEntryLinesUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const entryId = event.pathParameters?.entryId ?? '';
    if (!entryId) throw new ValidationError('entryId is required');

    const parsed = PatchBodySchema.safeParse(parseBody(event.body ?? undefined));
    if (!parsed.success) throw new ZodError(parsed.error.issues);

    const updated = await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      entryId,
      lines: parsed.data.lines,
    });
    return { statusCode: 200, body: JSON.stringify(updated) };
  };

export const buildConfirmEntryController =
  (ensureUser: EnsureUserExistsUseCase, useCase: ConfirmEntryUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const entryId = event.pathParameters?.entryId ?? '';
    if (!entryId) throw new ValidationError('entryId is required');

    const result = await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      entryId,
    });
    return { statusCode: 200, body: JSON.stringify(result) };
  };

export const buildDiscardEntryController =
  (ensureUser: EnsureUserExistsUseCase, useCase: DiscardEntryUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const entryId = event.pathParameters?.entryId ?? '';
    if (!entryId) throw new ValidationError('entryId is required');

    const result = await useCase.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      entryId,
    });
    return { statusCode: 200, body: JSON.stringify(result) };
  };
