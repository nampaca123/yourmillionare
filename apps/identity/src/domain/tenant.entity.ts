// Tenant entity: represents a Korean legal entity or sole proprietor.

import type { BizRegNo } from './biz-reg-no.value-object.js';

export type BusinessType = 'corporate' | 'sole_proprietor' | 'personal';
export type TaxType = 'general' | 'simplified' | 'tax_exempt';

export interface Tenant {
  readonly id: string;
  readonly bizRegNo: BizRegNo;
  readonly legalName: string;
  readonly displayName: string;
  readonly businessType: BusinessType;
  readonly taxType: TaxType;
  readonly fiscalYearStartMonth: number;
  readonly functionalCurrency: string;
  readonly foundedOn: Date | undefined;
  readonly regionCode: string | undefined;
  readonly createdAt: Date;
}

export const createTenant = (
  params: Omit<Tenant, 'createdAt' | 'businessType' | 'taxType' | 'fiscalYearStartMonth' | 'functionalCurrency'> &
    Partial<Pick<Tenant, 'businessType' | 'taxType' | 'fiscalYearStartMonth' | 'functionalCurrency' | 'createdAt'>>,
): Tenant => ({
  id: params.id,
  bizRegNo: params.bizRegNo,
  legalName: params.legalName,
  displayName: params.displayName,
  businessType: params.businessType ?? 'corporate',
  taxType: params.taxType ?? 'general',
  fiscalYearStartMonth: params.fiscalYearStartMonth ?? 1,
  functionalCurrency: params.functionalCurrency ?? 'KRW',
  foundedOn: params.foundedOn,
  regionCode: params.regionCode,
  createdAt: params.createdAt ?? new Date(),
});
