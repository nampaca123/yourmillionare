// Controller: POST /tenants/{tenantId}/journal/drafts/{rawTransactionId}/accept — promote draft to posted entry.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { ValidationError } from '@ym/shared-errors';
import type { AcceptDraftUseCase } from '../../../application/accept-draft.use-case.js';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';

const CorrectedLineSchema = z.object({
  lineNo: z.number().int().min(1),
  accountCode: z.string().min(1).max(20),
  debit: z.number().min(0),
  credit: z.number().min(0),
  memo: z.string().nullable().optional(),
});

const AcceptDraftBodySchema = z
  .object({
    correctedLines: z.array(CorrectedLineSchema).min(1).optional(),
  })
  .strict();

export const buildAcceptDraftController =
  (ensureUser: EnsureUserExistsUseCase, acceptDraft: AcceptDraftUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const rawTransactionId = event.pathParameters?.rawTransactionId ?? '';

    if (!rawTransactionId) {
      throw new ValidationError('rawTransactionId path parameter is required');
    }

    let body: unknown = {};
    if (event.body && event.body.trim().length > 0) {
      try {
        body = JSON.parse(event.body);
      } catch {
        throw new ValidationError('Request body is not valid JSON');
      }
    }

    const parsed = AcceptDraftBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(`Invalid accept-draft body: ${parsed.error.message}`);
    }

    const result = await acceptDraft.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      rawTransactionId,
      ...(parsed.data.correctedLines ? { correctedLines: parsed.data.correctedLines } : {}),
    });

    return { statusCode: 201, body: JSON.stringify(result) };
  };
