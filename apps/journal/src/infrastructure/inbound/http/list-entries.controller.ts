// ListEntries controller: GET /tenants/{tenantId}/journal/entries — returns entries + balance snapshot + draft transparency signal.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { ListJournalEntriesUseCase } from '../../../application/list-journal-entries.use-case.js';
import { listAccountBalances, countPendingDrafts } from '../../outbound/pg/pg-bank-accounts.repository.js';
import { parseClaims } from './auth-claims.mapper.js';
import { ListJournalEntriesQuerySchema } from './list-entries.schema.js';

const draftMessage = (count: number, tenantId: string): { count: number; message: string; reviewEndpoint: string } => ({
  count,
  message:
    count === 0
      ? 'AI 자동 분류 결과를 모두 확정했습니다. 추가 검토할 거래는 없습니다.'
      : `AI가 분류 결과에 확신이 없는 거래 ${count}건이 있어 직접 확인이 필요합니다. 아래 reviewEndpoint에서 상세 내역과 추천 분개를 확인한 뒤 확정/수정해 주세요.`,
  reviewEndpoint: `/tenants/${tenantId}/journal/drafts`,
});

export const buildListEntriesController =
  (ensureUser: EnsureUserExistsUseCase, listEntries: ListJournalEntriesUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';

    const parsed = ListJournalEntriesQuerySchema.safeParse(event.queryStringParameters ?? {});
    if (!parsed.success) throw new ZodError(parsed.error.issues);

    const [entries, accountBalances, draftCount] = await Promise.all([
      listEntries.execute({
        tenantId,
        userId: user.id,
        cognitoSub: claims.cognitoSub,
        fromDate: parsed.data.from,
        toDate: parsed.data.to,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      }),
      listAccountBalances(tenantId),
      countPendingDrafts(tenantId),
    ]);

    return {
      statusCode: 200,
      body: JSON.stringify({
        entries,
        accountBalances,
        pendingDrafts: draftMessage(draftCount, tenantId),
      }),
    };
  };
