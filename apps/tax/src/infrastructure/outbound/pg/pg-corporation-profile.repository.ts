// Reads + upserts tenant corporation-profile fields (extended columns on the tenants table per migration 0011).

import { withRlsContext } from './pg-rls.context.js';

export interface CorporationProfile {
  readonly tenantId: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly fiscalYearStartMonth: number;
  readonly foundedOn: string | null;
  readonly regionCode: string | null;
  readonly industryCode: string | null;
  readonly isYouthFounder: boolean;
  readonly isVentureCertified: boolean;
  readonly isExternalAudit: boolean;
  readonly vatPrepaymentRecipient: boolean;
  readonly withholdingCadence: 'MONTHLY' | 'SEMIANNUAL';
  readonly priorYearCorpTax: number | null;
  readonly priorYearRevenue: number | null;
}

interface ProfileRow {
  id: string;
  legal_name: string;
  display_name: string;
  fiscal_year_start_month: number;
  founded_on: string | null;
  region_code: string | null;
  industry_code: string | null;
  is_youth_founder: boolean;
  is_venture_certified: boolean;
  is_external_audit: boolean;
  vat_prepayment_recipient: boolean;
  withholding_cadence: 'MONTHLY' | 'SEMIANNUAL';
  prior_year_corp_tax: string | null;
  prior_year_revenue: string | null;
}

const toProfile = (row: ProfileRow): CorporationProfile => ({
  tenantId: row.id,
  legalName: row.legal_name,
  displayName: row.display_name,
  fiscalYearStartMonth: row.fiscal_year_start_month,
  foundedOn: row.founded_on,
  regionCode: row.region_code,
  industryCode: row.industry_code,
  isYouthFounder: row.is_youth_founder,
  isVentureCertified: row.is_venture_certified,
  isExternalAudit: row.is_external_audit,
  vatPrepaymentRecipient: row.vat_prepayment_recipient,
  withholdingCadence: row.withholding_cadence,
  priorYearCorpTax: row.prior_year_corp_tax ? Number.parseFloat(row.prior_year_corp_tax) : null,
  priorYearRevenue: row.prior_year_revenue ? Number.parseFloat(row.prior_year_revenue) : null,
});

export class PgCorporationProfileRepository {
  async find(input: { tenantId: string; cognitoSub: string; userId: string }): Promise<CorporationProfile | null> {
    return withRlsContext(
      { tenantId: input.tenantId, cognitoSub: 'system' },
      async (client) => {
        const result = await client.query<ProfileRow>(
          `SELECT id, legal_name, display_name, fiscal_year_start_month,
                  founded_on::text, region_code, industry_code,
                  is_youth_founder, is_venture_certified, is_external_audit,
                  vat_prepayment_recipient, withholding_cadence,
                  prior_year_corp_tax::text, prior_year_revenue::text
             FROM tenants WHERE id = $1`,
          [input.tenantId],
        );
        const row = result.rows[0];
        return row ? toProfile(row) : null;
      },
    );
  }

  async upsert(input: {
    tenantId: string;
    cognitoSub: string;
    userId: string;
    foundedOn?: string;
    regionCode?: string;
    industryCode?: string;
    isYouthFounder?: boolean;
    isVentureCertified?: boolean;
    isExternalAudit?: boolean;
    vatPrepaymentRecipient?: boolean;
    withholdingCadence?: 'MONTHLY' | 'SEMIANNUAL';
    fiscalYearStartMonth?: number;
    priorYearCorpTax?: number;
    priorYearRevenue?: number;
  }): Promise<CorporationProfile> {
    return withRlsContext(
      { tenantId: input.tenantId, cognitoSub: 'system' },
      async (client) => {
        await client.query(
          `UPDATE tenants SET
             founded_on              = COALESCE($2::date, founded_on),
             region_code              = COALESCE($3, region_code),
             industry_code            = COALESCE($4, industry_code),
             is_youth_founder         = COALESCE($5, is_youth_founder),
             is_venture_certified     = COALESCE($6, is_venture_certified),
             is_external_audit        = COALESCE($7, is_external_audit),
             vat_prepayment_recipient = COALESCE($8, vat_prepayment_recipient),
             withholding_cadence      = COALESCE($9, withholding_cadence),
             fiscal_year_start_month  = COALESCE($10, fiscal_year_start_month),
             prior_year_corp_tax      = COALESCE($11::numeric, prior_year_corp_tax),
             prior_year_revenue       = COALESCE($12::numeric, prior_year_revenue),
             profile_updated_at       = now()
           WHERE id = $1`,
          [
            input.tenantId,
            input.foundedOn ?? null,
            input.regionCode ?? null,
            input.industryCode ?? null,
            input.isYouthFounder ?? null,
            input.isVentureCertified ?? null,
            input.isExternalAudit ?? null,
            input.vatPrepaymentRecipient ?? null,
            input.withholdingCadence ?? null,
            input.fiscalYearStartMonth ?? null,
            input.priorYearCorpTax ?? null,
            input.priorYearRevenue ?? null,
          ],
        );
        const result = await client.query<ProfileRow>(
          `SELECT id, legal_name, display_name, fiscal_year_start_month,
                  founded_on::text, region_code, industry_code,
                  is_youth_founder, is_venture_certified, is_external_audit,
                  vat_prepayment_recipient, withholding_cadence,
                  prior_year_corp_tax::text, prior_year_revenue::text
             FROM tenants WHERE id = $1`,
          [input.tenantId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('Tenant not found after upsert');
        return toProfile(row);
      },
    );
  }
}
