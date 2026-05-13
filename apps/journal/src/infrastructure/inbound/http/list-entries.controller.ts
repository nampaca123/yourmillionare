// ListEntries controller: GET /tenants/{tenantId}/entries — returns all entries (certain + uncertain + discarded) with confidenceStatus on every row.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import { ValidationError } from '@ym/shared-errors';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { ListJournalEntriesUseCase } from '../../../application/list-journal-entries.use-case.js';
import type { ConfidenceStatus } from '../../../application/ports/entries.repository.port.js';
import { listAccountBalances, countUncertainEntries } from '../../outbound/pg/pg-bank-accounts.repository.js';
import { parseClaims } from './auth-claims.mapper.js';
import { ListJournalEntriesQuerySchema } from './list-entries.schema.js';

const VALID_STATUSES: ReadonlySet<ConfidenceStatus | 'all'> = new Set([
  'certain',
  'uncertain',
  'discarded',
  'all',
]);

const parseConfidenceStatus = (raw: string | undefined): ConfidenceStatus | 'all' => {
  if (raw === undefined) return 'all';
  if (!VALID_STATUSES.has(raw as ConfidenceStatus | 'all')) {
    throw new ValidationError(`Invalid confidenceStatus: ${raw}`);
  }
  return raw as ConfidenceStatus | 'all';
};

export const buildListEntriesController =
  (ensureUser: EnsureUserExistsUseCase, listEntries: ListJournalEntriesUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';

    const parsed = ListJournalEntriesQuerySchema.safeParse(event.queryStringParameters ?? {});
    if (!parsed.success) throw new ZodError(parsed.error.issues);
    const confidenceStatus = parseConfidenceStatus(event.queryStringParameters?.confidenceStatus);

    const [entries, accountBalances, uncertainCount] = await Promise.all([
      listEntries.execute({
        tenantId,
        userId: user.id,
        cognitoSub: claims.cognitoSub,
        fromDate: parsed.data.from,
        toDate: parsed.data.to,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        confidenceStatus,
      }),
      listAccountBalances(tenantId),
      countUncertainEntries(tenantId),
    ]);

    return {
      statusCode: 200,
      body: JSON.stringify({
        entries,
        accountBalances,
        uncertain: {
          count: uncertainCount,
          message:
            uncertainCount === 0
              ? 'AI 자동 분류 결과를 모두 확정했습니다. 검토 필요 항목 없음.'
              : `AI가 ${uncertainCount}건을 확신 없이 분류했습니다. confidenceStatus="uncertain" 인 항목을 검토/수정/확정해 주세요.`,
          confirmEndpoint: `/tenants/${tenantId}/entries/{entryId}/confirm`,
          discardEndpoint: `/tenants/${tenantId}/entries/{entryId}/discard`,
          patchEndpoint: `/tenants/${tenantId}/entries/{entryId}`,
        },
      }),
    };
  };
