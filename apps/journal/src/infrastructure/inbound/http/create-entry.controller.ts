// CreateEntry controller: validates and persists a manual double-entry journal entry.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { VerifyTenantMembershipUseCase } from '../../../application/verify-tenant-membership.use-case.js';
import type { CreateJournalEntryUseCase } from '../../../application/create-journal-entry.use-case.js';
import { createJournalLine } from '../../../domain/journal-line.value-object.js';
import { parseClaims } from './auth-claims.mapper.js';
import { CreateEntryBodySchema } from './create-entry.schema.js';
import { ValidationError } from '@ym/shared-errors';

export const buildCreateEntryController =
  (ensureUser: EnsureUserExistsUseCase, verifyMembership: VerifyTenantMembershipUseCase, createEntry: CreateJournalEntryUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';

    await verifyMembership.execute({ tenantId, userId: user.id, cognitoSub: claims.cognitoSub });

    let body: unknown;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      throw new ValidationError('Request body is not valid JSON');
    }

    const parsed = CreateEntryBodySchema.safeParse(body);
    if (!parsed.success) throw new ZodError(parsed.error.issues);

    const lines = parsed.data.lines.map((l) =>
      createJournalLine({ lineNo: l.lineNo, accountCode: l.accountCode, debit: l.debit, credit: l.credit, memo: l.memo }),
    );

    const entry = await createEntry.execute({
      tenantId,
      userId: user.id,
      entryDate: parsed.data.entryDate,
      description: parsed.data.description,
      lines,
    });

    return {
      statusCode: 201,
      body: JSON.stringify({ id: entry.id, tenantId: entry.tenantId, entryDate: entry.entryDate, lines: entry.lines }),
    };
  };
