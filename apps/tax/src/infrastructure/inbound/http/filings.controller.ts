// Controllers: filing obligations endpoints (upcoming list, draft retrieval, penalty simulation, recompute). Stubs return placeholder until Wave-5 hooks up the filing engine.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { withRlsContext } from '../../outbound/pg/pg-rls.context.js';
import { parseClaims } from './auth-claims.mapper.js';

interface FilingRow {
  id: string;
  kind: string;
  period_start: string;
  period_end: string;
  business_due_date: string;
  status: string;
}

export const filingsUpcomingController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';
  const filings = await withRlsContext(
    { tenantId, cognitoSub: claims.cognitoSub },
    async (client) => {
      const result = await client.query<FilingRow>(
        `SELECT id, kind::text, period_start::text, period_end::text,
                business_due_date::text, status::text
           FROM filing_obligation
          WHERE tenant_id = $1 AND status = 'pending'
       ORDER BY business_due_date ASC
          LIMIT 20`,
        [tenantId],
      );
      return result.rows;
    },
  );
  return { statusCode: 200, body: JSON.stringify({ filings }) };
};

export const filingDraftController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  parseClaims(event.requestContext.authorizer.jwt.claims);
  const filingId = event.pathParameters?.id ?? '';
  return {
    statusCode: 200,
    body: JSON.stringify({
      filingId,
      draft: null,
      appliedRules: [],
      citedChunks: [],
      verification: {
        allRulesApproved: false,
        unapprovedRuleIds: [],
        kbStale: false,
        warning: 'Wave-5 will populate this draft from tax_rule + KB citations.',
      },
    }),
  };
};

export const filingPenaltySimulationController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  parseClaims(event.requestContext.authorizer.jwt.claims);
  const filingId = event.pathParameters?.id ?? '';
  const asOf = event.queryStringParameters?.asOf ?? new Date().toISOString().slice(0, 10);
  return {
    statusCode: 200,
    body: JSON.stringify({
      filingId,
      asOf,
      penalties: [],
      disclaimer: '추정치입니다. 실제 신고 전 세무사 검토가 필요합니다.',
    }),
  };
};

export const filingRecomputeController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  parseClaims(event.requestContext.authorizer.jwt.claims);
  return { statusCode: 202, body: JSON.stringify({ status: 'queued', pending: 'Wave-5: re-aggregate journal_entries + apply tax_rule lookup' }) };
};
