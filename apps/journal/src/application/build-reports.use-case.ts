// Use case: orchestrate report builders against PgReportsRepository aggregates.

import {
  buildBalanceSheet,
  buildCashFlowStatement,
  buildIncomeStatement,
  buildTrialBalance,
  type BalanceSheet,
  type CashFlowStatement,
  type IncomeStatement,
  type LineItem,
  type ReportMetadata,
  type TrialBalance,
} from '@ym/reports-core';
import type { ReportsRepository } from './ports/reports.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

const buildMetadata = (includesUnclassifiedDrafts: boolean): ReportMetadata => ({
  generatedAt: new Date().toISOString(),
  accountingStandard: 'K-IFRS',
  includesUnclassifiedDrafts,
});

export class BuildIncomeStatementUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly reports: ReportsRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    fromDate: string;
    toDate: string;
  }): Promise<IncomeStatement> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    const [rows, drafts] = await Promise.all([
      this.reports.pnlAggregates({
        tenantId: params.tenantId,
        fromDate: params.fromDate,
        toDate: params.toDate,
      }),
      this.reports.hasUnclassifiedDrafts({
        tenantId: params.tenantId,
        fromDate: params.fromDate,
        toDate: params.toDate,
      }),
    ]);
    return buildIncomeStatement({
      from: params.fromDate,
      to: params.toDate,
      rows,
      metadata: buildMetadata(drafts),
    });
  }
}

export class BuildBalanceSheetUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly reports: ReportsRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    asOf: string;
  }): Promise<BalanceSheet> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    const [rows, drafts] = await Promise.all([
      this.reports.balanceSheetAggregates({ tenantId: params.tenantId, asOf: params.asOf }),
      this.reports.hasUnclassifiedDrafts({
        tenantId: params.tenantId,
        fromDate: '1970-01-01',
        toDate: params.asOf,
      }),
    ]);
    return buildBalanceSheet({ asOf: params.asOf, rows, metadata: buildMetadata(drafts) });
  }
}

export class BuildTrialBalanceUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly reports: ReportsRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    asOf: string;
  }): Promise<TrialBalance> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    const rows = await this.reports.trialBalanceAggregates({ tenantId: params.tenantId, asOf: params.asOf });
    return buildTrialBalance(params.asOf, rows, buildMetadata(false));
  }
}

export class BuildCashFlowUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly reports: ReportsRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    fromDate: string;
    toDate: string;
  }): Promise<CashFlowStatement> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    const [pnlRows, openingCash, closingCash, drafts] = await Promise.all([
      this.reports.pnlAggregates({
        tenantId: params.tenantId,
        fromDate: params.fromDate,
        toDate: params.toDate,
      }),
      this.reports.cashSnapshot({
        tenantId: params.tenantId,
        asOf: this.previousDay(params.fromDate),
      }),
      this.reports.cashSnapshot({ tenantId: params.tenantId, asOf: params.toDate }),
      this.reports.hasUnclassifiedDrafts({
        tenantId: params.tenantId,
        fromDate: params.fromDate,
        toDate: params.toDate,
      }),
    ]);
    const netIncome =
      pnlRows.filter((r) => r.accountKind === 'revenue').reduce((s, r) => s + r.amount, 0) -
      pnlRows.filter((r) => ['cogs', 'operating_expense'].includes(r.accountKind)).reduce((s, r) => s + r.amount, 0) +
      pnlRows.filter((r) => r.accountKind === 'non_operating').reduce((s, r) => s + r.amount, 0) -
      pnlRows.filter((r) => r.accountKind === 'income_tax').reduce((s, r) => s + r.amount, 0);

    const operatingAdjustments: LineItem[] = [
      { accountCode: '__working_capital_delta', accountName: '운전자본 변동', amount: closingCash - openingCash - netIncome },
    ];

    return buildCashFlowStatement({
      from: params.fromDate,
      to: params.toDate,
      netIncome,
      operatingAdjustments,
      investingFlows: [],
      financingFlows: [],
      openingCash,
      closingCash,
      metadata: buildMetadata(drafts),
    });
  }

  private previousDay(date: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
}
