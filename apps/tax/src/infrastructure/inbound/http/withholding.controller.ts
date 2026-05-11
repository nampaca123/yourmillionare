// Controllers: withholding tax queue (pending list + file).

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { withRlsContext } from '../../outbound/pg/pg-rls.context.js';
import { parseClaims } from './auth-claims.mapper.js';

interface WithholdingRow {
  id: string;
  payee_label: string;
  payee_biz_no: string | null;
  income_type: string;
  gross_amount: string;
  income_tax: string;
  local_income_tax: string;
  payment_date: string;
  filing_due_date: string;
  status: string;
}

export const withholdingPendingController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';
  const items = await withRlsContext({ tenantId, cognitoSub: claims.cognitoSub }, async (client) => {
    const result = await client.query<WithholdingRow>(
      `SELECT id, payee_label, payee_biz_no, income_type::text,
              gross_amount::text, income_tax::text, local_income_tax::text,
              payment_date::text, filing_due_date::text, status::text
         FROM withholding_payment
        WHERE tenant_id = $1 AND status = 'pending'
     ORDER BY filing_due_date ASC
        LIMIT 100`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      payeeLabel: row.payee_label,
      payeeBizNo: row.payee_biz_no,
      incomeType: row.income_type,
      grossAmount: Number.parseFloat(row.gross_amount),
      incomeTax: Number.parseFloat(row.income_tax),
      localIncomeTax: Number.parseFloat(row.local_income_tax),
      paymentDate: row.payment_date,
      filingDueDate: row.filing_due_date,
      status: row.status,
    }));
  });
  return { statusCode: 200, body: JSON.stringify({ items }) };
};

export const withholdingFileController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';
  const withholdingId = event.pathParameters?.id ?? '';
  await withRlsContext({ tenantId, cognitoSub: claims.cognitoSub }, async (client) => {
    await client.query(
      `UPDATE withholding_payment SET status = 'filed', filed_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
      [withholdingId, tenantId],
    );
  });
  return { statusCode: 200, body: JSON.stringify({ id: withholdingId, status: 'filed' }) };
};
