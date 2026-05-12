// Controller: GET /tenants/{id}/tax-invoices — lists CODEF-collected 전자세금계산서 entries.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { withRlsContext } from '../../outbound/pg/pg-rls.context.js';
import { parseClaims } from './auth-claims.mapper.js';

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  direction: z.enum(['SALE', 'PURCHASE']).optional(),
});

interface InvoiceRow {
  id: string;
  direction: string;
  supplier_biz_no: string | null;
  buyer_biz_no: string | null;
  supply_amount: string;
  vat_amount: string;
  written_date: string;
  doc_type: string;
  is_zero_rate: boolean;
  is_deductible: boolean;
  non_deductible_reason: string | null;
}

export const taxInvoicesController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';
  const parsed = QuerySchema.safeParse(event.queryStringParameters ?? {});
  if (!parsed.success) throw new ZodError(parsed.error.issues);

  const items = await withRlsContext({ tenantId, cognitoSub: claims.cognitoSub }, async (client) => {
    const result = await client.query<InvoiceRow>(
      `SELECT id, direction::text, supplier_biz_no, buyer_biz_no,
              supply_amount::text, vat_amount::text, written_date::text,
              doc_type, is_zero_rate, is_deductible, non_deductible_reason
         FROM tax_invoice
        WHERE tenant_id = $1
          AND written_date BETWEEN $2 AND $3
          AND ($4::text IS NULL OR direction::text = $4)
     ORDER BY written_date DESC
        LIMIT 200`,
      [tenantId, parsed.data.from, parsed.data.to, parsed.data.direction ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      direction: row.direction,
      supplierBizNo: row.supplier_biz_no,
      buyerBizNo: row.buyer_biz_no,
      supplyAmount: Number.parseFloat(row.supply_amount),
      vatAmount: Number.parseFloat(row.vat_amount),
      writtenDate: row.written_date,
      docType: row.doc_type,
      isZeroRate: row.is_zero_rate,
      isDeductible: row.is_deductible,
      nonDeductibleReason: row.non_deductible_reason,
    }));
  });
  return { statusCode: 200, body: JSON.stringify({ items }) };
};
