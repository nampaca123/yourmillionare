// Controllers: /admin/* routes for tax-rule governance + KB sync ops. Requires Cognito ym-tax-admin group claim.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { ValidationError } from '@ym/shared-errors';
import { withRlsContext } from '../../outbound/pg/pg-rls.context.js';
import { parseClaims, requireTaxAdmin } from './auth-claims.mapper.js';

const RulesQuerySchema = z.object({
  kind: z.string().optional(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const ReviewResolveSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  notes: z.string().max(1000).optional(),
});

export const adminTaxRulesController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  requireTaxAdmin(claims);
  const parsed = RulesQuerySchema.safeParse(event.queryStringParameters ?? {});
  if (!parsed.success) throw new ZodError(parsed.error.issues);

  const rules = await withRlsContext(
    { cognitoSub: claims.cognitoSub, isTaxAdmin: true },
    async (client) => {
      const result = await client.query<{
        id: string;
        rule_kind: string;
        bracket_from: string | null;
        bracket_to: string | null;
        rate: string;
        effective_from: string;
        effective_to: string | null;
        legal_basis: string;
        approved_at: Date | null;
      }>(
        `SELECT id, rule_kind, bracket_from::text, bracket_to::text, rate::text,
                effective_from::text, effective_to::text, legal_basis, approved_at
           FROM tax_rule
          WHERE ($1::text IS NULL OR rule_kind = $1)
            AND ($2::date IS NULL OR (effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2)))
       ORDER BY rule_kind, effective_from DESC`,
        [parsed.data.kind ?? null, parsed.data.asOf ?? null],
      );
      return result.rows.map((row) => ({
        id: row.id,
        ruleKind: row.rule_kind,
        bracketFrom: row.bracket_from ? Number.parseFloat(row.bracket_from) : null,
        bracketTo: row.bracket_to ? Number.parseFloat(row.bracket_to) : null,
        rate: Number.parseFloat(row.rate),
        effectiveFrom: row.effective_from,
        effectiveTo: row.effective_to,
        legalBasis: row.legal_basis,
        approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
      }));
    },
  );
  return { statusCode: 200, body: JSON.stringify({ rules }) };
};

export const adminApproveRuleController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  requireTaxAdmin(claims);
  const ruleId = event.pathParameters?.id ?? '';

  const result = await withRlsContext(
    { cognitoSub: claims.cognitoSub, isTaxAdmin: true },
    async (client) => {
      const userIdResult = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE cognito_sub = $1 LIMIT 1`,
        [claims.cognitoSub],
      );
      const approverId = userIdResult.rows[0]?.id;
      if (!approverId) throw new ValidationError('Approver user not found');
      await client.query(
        `INSERT INTO tax_rule_approval (rule_id, approver_user_id) VALUES ($1, $2)
         ON CONFLICT (rule_id, approver_user_id) DO NOTHING`,
        [ruleId, approverId],
      );
      const status = await client.query<{ approved_at: Date | null }>(
        `SELECT approved_at FROM tax_rule WHERE id = $1`,
        [ruleId],
      );
      return status.rows[0]?.approved_at ? 'approved' : 'pending';
    },
  );
  return { statusCode: 200, body: JSON.stringify({ ruleId, status: result }) };
};

export const adminRuleChangeLogController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  requireTaxAdmin(claims);
  const ruleId = event.pathParameters?.id ?? '';
  const entries = await withRlsContext(
    { cognitoSub: claims.cognitoSub, isTaxAdmin: true },
    async (client) => {
      const result = await client.query<{
        id: string;
        action: string;
        changed_at: Date;
        actor_user_id: string | null;
        reason: string | null;
      }>(
        `SELECT id, action, changed_at, actor_user_id, reason
           FROM tax_rule_change_log
          WHERE rule_id = $1
       ORDER BY changed_at DESC
          LIMIT 200`,
        [ruleId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        action: row.action,
        changedAt: row.changed_at.toISOString(),
        actorUserId: row.actor_user_id,
        reason: row.reason,
      }));
    },
  );
  return { statusCode: 200, body: JSON.stringify({ entries }) };
};

export const adminSyncStateController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  requireTaxAdmin(claims);
  const items = await withRlsContext(
    { cognitoSub: claims.cognitoSub, isTaxAdmin: true },
    async (client) => {
      const result = await client.query<{
        law_id: string;
        law_name: string;
        target_code: string;
        current_mst: string | null;
        effective_from: string | null;
        last_synced_at: Date | null;
        consecutive_failures: number;
        kb_chunk_active: boolean;
      }>(
        `SELECT law_id, law_name, target_code, current_mst, effective_from::text,
                last_synced_at, consecutive_failures, kb_chunk_active
           FROM tax_law_sync_state ORDER BY law_id`,
      );
      return result.rows.map((row) => ({
        lawId: row.law_id,
        lawName: row.law_name,
        targetCode: row.target_code,
        currentMst: row.current_mst,
        effectiveFrom: row.effective_from,
        lastSyncedAt: row.last_synced_at ? row.last_synced_at.toISOString() : null,
        consecutiveFailures: row.consecutive_failures,
        kbChunkActive: row.kb_chunk_active,
      }));
    },
  );
  return { statusCode: 200, body: JSON.stringify({ items }) };
};

export const adminSyncRunController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  requireTaxAdmin(claims);
  const arn = process.env.LEGAL_SYNC_STATE_MACHINE_ARN ?? '';
  if (!arn) throw new ValidationError('LEGAL_SYNC_STATE_MACHINE_ARN env is not configured');
  const sfn = new SFNClient({ region: process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2' });
  const out = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, input: JSON.stringify({ triggeredBy: 'manual' }) }));
  return { statusCode: 202, body: JSON.stringify({ executionArn: out.executionArn ?? '' }) };
};

export const adminListReviewsController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  requireTaxAdmin(claims);
  const status = event.queryStringParameters?.status ?? 'pending';
  const items = await withRlsContext(
    { cognitoSub: claims.cognitoSub, isTaxAdmin: true },
    async (client) => {
      const result = await client.query<{
        id: string;
        rule_kind: string | null;
        triggered_by: string;
        detected_at: Date;
        legal_basis_law_id: string | null;
        legal_basis_mst: string | null;
        status: string;
      }>(
        `SELECT id, rule_kind, triggered_by, detected_at, legal_basis_law_id, legal_basis_mst, status
           FROM tax_rule_review_request
          WHERE status = $1
       ORDER BY detected_at DESC LIMIT 100`,
        [status],
      );
      return result.rows.map((row) => ({
        id: row.id,
        ruleKind: row.rule_kind,
        triggeredBy: row.triggered_by,
        detectedAt: row.detected_at.toISOString(),
        legalBasisLawId: row.legal_basis_law_id,
        legalBasisMst: row.legal_basis_mst,
        status: row.status,
      }));
    },
  );
  return { statusCode: 200, body: JSON.stringify({ items }) };
};

export const adminResolveReviewController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  requireTaxAdmin(claims);
  const reviewId = event.pathParameters?.id ?? '';
  if (!event.body) throw new ValidationError('Request body is required');
  let body: unknown;
  try {
    body = JSON.parse(event.body);
  } catch {
    throw new ValidationError('Body is not valid JSON');
  }
  const parsed = ReviewResolveSchema.safeParse(body);
  if (!parsed.success) throw new ZodError(parsed.error.issues);
  await withRlsContext({ cognitoSub: claims.cognitoSub, isTaxAdmin: true }, async (client) => {
    await client.query(
      `UPDATE tax_rule_review_request SET status = $2, resolved_at = now(), notes = $3 WHERE id = $1`,
      [reviewId, parsed.data.decision === 'approve' ? 'approved' : 'rejected', parsed.data.notes ?? null],
    );
    if (parsed.data.decision === 'approve') {
      await client.query(
        `UPDATE tax_law_sync_state SET kb_chunk_active = true
          WHERE law_id = (SELECT legal_basis_law_id FROM tax_rule_review_request WHERE id = $1)`,
        [reviewId],
      );
    }
  });
  return { statusCode: 200, body: JSON.stringify({ id: reviewId, decision: parsed.data.decision }) };
};
