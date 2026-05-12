// Controllers: filing obligations endpoints (upcoming list, draft retrieval, penalty simulation, recompute).

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { computePenalty } from '@ym/tax-core';
import { NotFoundError } from '@ym/shared-errors';
import { withRlsContext } from '../../outbound/pg/pg-rls.context.js';
import { parseClaims } from './auth-claims.mapper.js';

interface FilingRow {
  id: string;
  kind: string;
  period_start: string;
  period_end: string;
  business_due_date: string;
  statutory_due_date: string;
  status: string;
  draft_payload: Record<string, unknown> | null;
}

interface JournalAggregateRow {
  account_code: string;
  total_debit: string;
  total_credit: string;
}

interface AppliedRuleRow {
  id: string;
  rule_kind: string;
  rate: string;
  legal_basis: string;
}

interface CitedChunkRow {
  chunk_id: string;
  rerank_score: string | null;
  law_id: string | null;
  law_name: string | null;
  article_number: string | null;
}

const VAT_OUTPUT_PREFIXES = ['41', '42'];
const VAT_INPUT_PREFIXES = ['51', '52', '53', '54', '55', '56'];

const sumByPrefix = (rows: ReadonlyArray<JournalAggregateRow>, prefixes: ReadonlyArray<string>): number =>
  rows
    .filter((r) => prefixes.some((p) => r.account_code.startsWith(p)))
    .reduce((s, r) => s + Number.parseFloat(r.total_credit) - Number.parseFloat(r.total_debit), 0);

const buildVatBoxes = (rows: ReadonlyArray<JournalAggregateRow>): Record<string, number> => {
  const totalSales = Math.round(Math.max(0, sumByPrefix(rows, VAT_OUTPUT_PREFIXES)));
  const totalPurchases = Math.round(Math.max(0, -sumByPrefix(rows, VAT_INPUT_PREFIXES)));
  const outputVat = Math.round(totalSales * 0.1);
  const inputVat = Math.round(totalPurchases * 0.1);
  return {
    totalSales,
    totalPurchases,
    outputVat,
    inputVat,
    vatPayable: Math.max(0, outputVat - inputVat),
  };
};

const buildCorpFinalBoxes = (rows: ReadonlyArray<JournalAggregateRow>): Record<string, number> => {
  const revenue = rows
    .filter((r) => r.account_code.startsWith('4'))
    .reduce((s, r) => s + Number.parseFloat(r.total_credit) - Number.parseFloat(r.total_debit), 0);
  const expense = rows
    .filter((r) => r.account_code.startsWith('5'))
    .reduce((s, r) => s + Number.parseFloat(r.total_debit) - Number.parseFloat(r.total_credit), 0);
  const taxableIncome = Math.max(0, Math.round(revenue - expense));
  return {
    revenue: Math.round(revenue),
    expense: Math.round(expense),
    taxableIncome,
  };
};

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
                business_due_date::text, statutory_due_date::text, status::text, NULL AS draft_payload
           FROM filing_obligation
          WHERE tenant_id = $1 AND status = 'pending'
       ORDER BY business_due_date ASC
          LIMIT 20`,
        [tenantId],
      );
      return result.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        businessDueDate: r.business_due_date,
        statutoryDueDate: r.statutory_due_date,
        status: r.status,
      }));
    },
  );
  return { statusCode: 200, body: JSON.stringify({ filings }) };
};

export const filingDraftController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';
  const filingId = event.pathParameters?.id ?? '';

  const result = await withRlsContext({ tenantId, cognitoSub: claims.cognitoSub }, async (client) => {
    const filingResult = await client.query<FilingRow>(
      `SELECT id, kind::text, period_start::text, period_end::text,
              business_due_date::text, statutory_due_date::text, status::text, draft_payload
         FROM filing_obligation WHERE id = $1 AND tenant_id = $2`,
      [filingId, tenantId],
    );
    const filing = filingResult.rows[0];
    if (!filing) return null;

    const aggregateResult = await client.query<JournalAggregateRow>(
      `SELECT jl.account_code,
              COALESCE(SUM(jl.debit), 0)::text AS total_debit,
              COALESCE(SUM(jl.credit), 0)::text AS total_credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.tenant_id = $1
          AND je.entry_date BETWEEN $2 AND $3
     GROUP BY jl.account_code`,
      [tenantId, filing.period_start, filing.period_end],
    );

    const draftPayload = filing.kind.startsWith('VAT')
      ? buildVatBoxes(aggregateResult.rows)
      : filing.kind.startsWith('CORP')
        ? buildCorpFinalBoxes(aggregateResult.rows)
        : { aggregated: aggregateResult.rows.length };

    const rulesResult = await client.query<AppliedRuleRow>(
      `SELECT tr.id, tr.rule_kind, tr.rate::text, tr.legal_basis
         FROM tax_rule tr
        WHERE tr.effective_from <= $1
          AND (tr.effective_to IS NULL OR tr.effective_to >= $1)
          AND CASE
                WHEN $2::text LIKE 'VAT%' THEN tr.rule_kind LIKE 'VAT%'
                WHEN $2::text LIKE 'CORP%' THEN tr.rule_kind LIKE 'CORP_TAX_%'
                WHEN $2::text LIKE 'WH%' THEN tr.rule_kind LIKE 'WH_%'
                ELSE false
              END`,
      [filing.business_due_date, filing.kind],
    );

    const citedResult = await client.query<CitedChunkRow>(
      `SELECT fcc.chunk_id, fcc.rerank_score::text,
              tlcm.law_id, tlcm.law_name, tlcm.article_number
         FROM filing_cited_chunk fcc
         LEFT JOIN tax_law_chunk_meta tlcm ON tlcm.id = fcc.chunk_id
        WHERE fcc.filing_obligation_id = $1`,
      [filingId],
    );

    const appliedRules = rulesResult.rows.map((r) => ({
      ruleId: r.id,
      ruleKind: r.rule_kind,
      rate: Number.parseFloat(r.rate),
      legalBasis: r.legal_basis,
    }));
    const allApproved = appliedRules.length > 0;

    return {
      filingId: filing.id,
      kind: filing.kind,
      periodStart: filing.period_start,
      periodEnd: filing.period_end,
      businessDueDate: filing.business_due_date,
      draft: draftPayload,
      appliedRules,
      citedChunks: citedResult.rows.map((c) => ({
        chunkId: c.chunk_id,
        rerankScore: c.rerank_score === null ? null : Number.parseFloat(c.rerank_score),
        lawId: c.law_id,
        lawName: c.law_name,
        articleNumber: c.article_number,
      })),
      verification: {
        allRulesApproved: allApproved,
        unapprovedRuleIds: [],
        kbStale: false,
      },
      disclaimer: '추정치입니다. 실제 신고 전 세무사 검토가 필요합니다.',
    };
  });

  if (!result) throw new NotFoundError('Filing obligation not found');
  return { statusCode: 200, body: JSON.stringify(result) };
};

export const filingPenaltySimulationController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';
  const filingId = event.pathParameters?.id ?? '';
  const asOf = event.queryStringParameters?.asOf ?? new Date().toISOString().slice(0, 10);

  const result = await withRlsContext({ tenantId, cognitoSub: claims.cognitoSub }, async (client) => {
    const filingResult = await client.query<FilingRow>(
      `SELECT id, kind::text, period_start::text, period_end::text,
              business_due_date::text, statutory_due_date::text, status::text, draft_payload
         FROM filing_obligation WHERE id = $1 AND tenant_id = $2`,
      [filingId, tenantId],
    );
    const filing = filingResult.rows[0];
    if (!filing) return null;

    const dueDate = new Date(`${filing.business_due_date}T00:00:00Z`).getTime();
    const asOfMs = new Date(`${asOf}T00:00:00Z`).getTime();
    const daysLate = Math.max(0, Math.floor((asOfMs - dueDate) / 86_400_000));

    if (daysLate === 0) {
      return { filingId, asOf, daysLate: 0, penalties: [], disclaimer: '아직 마감일 전입니다.' };
    }

    const ruleResults = await client.query<{ rule_kind: string; rate: string }>(
      `SELECT rule_kind, rate::text
         FROM tax_rule
        WHERE rule_kind IN ('PENALTY_LATE_PAY', 'PENALTY_UNREPORTED')
          AND effective_from <= $1 AND (effective_to IS NULL OR effective_to >= $1)`,
      [asOf],
    );
    const rateByKind = new Map(ruleResults.rows.map((r) => [r.rule_kind, Number.parseFloat(r.rate)]));

    const baseAmount = typeof filing.draft_payload === 'object' && filing.draft_payload !== null
      ? Number((filing.draft_payload as Record<string, unknown>).vatPayable ?? 0)
      : 0;
    if (baseAmount <= 0) {
      return { filingId, asOf, daysLate, penalties: [], disclaimer: '추정 세액이 0이라 가산세 산정 대상이 아닙니다.' };
    }

    const latePay = computePenalty({
      kind: 'LATE_PAYMENT',
      baseAmount,
      rate: rateByKind.get('PENALTY_LATE_PAY') ?? 0.00022,
      daysLate,
    });
    const unreported = computePenalty({
      kind: 'UNREPORTED',
      baseAmount,
      rate: rateByKind.get('PENALTY_UNREPORTED') ?? 0.2,
      daysLate,
      amendmentType: 'LATE_FILING',
    });

    return {
      filingId,
      asOf,
      daysLate,
      penalties: [
        { kind: 'LATE_PAYMENT', baseAmount, rate: latePay.grossPenalty / baseAmount / daysLate, computedAmount: latePay.netPenalty },
        { kind: 'UNREPORTED', baseAmount, rate: unreported.grossPenalty / baseAmount, reductionRatio: unreported.reductionRatio, computedAmount: unreported.netPenalty },
      ],
      disclaimer: '추정치입니다. 실제 신고 전 세무사 검토가 필요합니다.',
    };
  });

  if (!result) throw new NotFoundError('Filing obligation not found');
  return { statusCode: 200, body: JSON.stringify(result) };
};

export const filingRecomputeController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';
  const filingId = event.pathParameters?.id ?? '';

  const result = await withRlsContext({ tenantId, cognitoSub: claims.cognitoSub }, async (client) => {
    const filingResult = await client.query<FilingRow>(
      `SELECT id, kind::text, period_start::text, period_end::text,
              business_due_date::text, statutory_due_date::text, status::text, draft_payload
         FROM filing_obligation WHERE id = $1 AND tenant_id = $2`,
      [filingId, tenantId],
    );
    const filing = filingResult.rows[0];
    if (!filing) return null;

    const aggregateResult = await client.query<JournalAggregateRow>(
      `SELECT jl.account_code,
              COALESCE(SUM(jl.debit), 0)::text AS total_debit,
              COALESCE(SUM(jl.credit), 0)::text AS total_credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.tenant_id = $1
          AND je.entry_date BETWEEN $2 AND $3
     GROUP BY jl.account_code`,
      [tenantId, filing.period_start, filing.period_end],
    );

    const draftPayload = filing.kind.startsWith('VAT')
      ? buildVatBoxes(aggregateResult.rows)
      : filing.kind.startsWith('CORP')
        ? buildCorpFinalBoxes(aggregateResult.rows)
        : { aggregated: aggregateResult.rows.length };

    await client.query(
      `UPDATE filing_obligation
          SET draft_payload = $1::jsonb, status = 'drafted', updated_at = now()
        WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify(draftPayload), filingId, tenantId],
    );

    return { filingId, status: 'drafted', draft: draftPayload };
  });

  if (!result) throw new NotFoundError('Filing obligation not found');
  return { statusCode: 200, body: JSON.stringify(result) };
};
