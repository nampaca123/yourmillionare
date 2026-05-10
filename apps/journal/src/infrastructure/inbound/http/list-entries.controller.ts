// ListEntries controller: GET /tenants/{tenantId}/journal/entries — returns classified entries within a date range.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { ListJournalEntriesUseCase } from '../../../application/list-journal-entries.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';
import { ListJournalEntriesQuerySchema } from './list-entries.schema.js';

export const buildListEntriesController =
  (ensureUser: EnsureUserExistsUseCase, listEntries: ListJournalEntriesUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';

    const parsed = ListJournalEntriesQuerySchema.safeParse(event.queryStringParameters ?? {});
    if (!parsed.success) throw new ZodError(parsed.error.issues);

    const entries = await listEntries.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      fromDate: parsed.data.from,
      toDate: parsed.data.to,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ entries }),
    };
  };
