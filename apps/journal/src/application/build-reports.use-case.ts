// Use case: orchestrate report builders against PgReportsRepository aggregates (certain/uncertain breakdown).

import {
  addBreakdown,
  buildBalanceSheet,
  buildCashFlowStatement,
  buildIncomeStatement,
  buildTrialBalance,
  subtractBreakdown,
  sumBreakdown,
  zeroBreakdown,
  type AmountBreakdown,
  type BalanceSheet,
  type CashFlowStatement,
  type IncomeStatement,
  type LineItem,
  type ReportMetadata,
  type TrialBalance,
} from '@ym/reports-core';
import type { ReportsRepository } from './ports/reports.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

const buildMetadata = (uncertainEntryCount: number): ReportMetadata => ({
  generatedAt: new Date().toISOString(),
  accountingStandard: 'K-IFRS',
  uncertainEntryCount,
  note:
    uncertainEntryCount === 0
      ? 'All entries are confirmed.'
      : `${uncertainEntryCount} entries are AI-suggested and not yet user-confirmed. Their amounts are included in every total as the "uncertain" breakdown; "certain" is the audit-grade subset.`,
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
    const [rows, uncertainCount] = await Promise.all([
      this.reports.pnlAggregates({
        tenantId: params.tenantId,
        fromDate: params.fromDate,
        toDate: params.toDate,
      }),
      this.reports.countUncertain({ tenantId: params.tenantId }),
    ]);
    return buildIncomeStatement({
      from: params.fromDate,
      to: params.toDate,
      rows,
      metadata: buildMetadata(uncertainCount),
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
    const [rows, uncertainCount] = await Promise.all([
      this.reports.balanceSheetAggregates({ tenantId: params.tenantId, asOf: params.asOf }),
      this.reports.countUncertain({ tenantId: params.tenantId }),
    ]);
    return buildBalanceSheet({
      asOf: params.asOf,
      rows,
      metadata: buildMetadata(uncertainCount),
    });
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
    const [rows, uncertainCount] = await Promise.all([
      this.reports.trialBalanceAggregates({ tenantId: params.tenantId, asOf: params.asOf }),
      this.reports.countUncertain({ tenantId: params.tenantId }),
    ]);
    return buildTrialBalance(params.asOf, rows, buildMetadata(uncertainCount));
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
    const [pnlRows, openingCash, closingCash, uncertainCount] = await Promise.all([
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
      this.reports.countUncertain({ tenantId: params.tenantId }),
    ]);

    const revenueTotal = sumBreakdown(pnlRows.filter((r) => r.accountKind === 'revenue').map((r) => r.amount));
    const expenseTotal = sumBreakdown(
      pnlRows.filter((r) => ['cogs', 'operating_expense'].includes(r.accountKind)).map((r) => r.amount),
    );
    const nonOpTotal = sumBreakdown(pnlRows.filter((r) => r.accountKind === 'non_operating').map((r) => r.amount));
    const taxTotal = sumBreakdown(pnlRows.filter((r) => r.accountKind === 'income_tax').map((r) => r.amount));

    const netIncome = subtractBreakdown(
      addBreakdown(subtractBreakdown(revenueTotal, expenseTotal), nonOpTotal),
      taxTotal,
    );

    const cashDelta: AmountBreakdown = subtractBreakdown(closingCash, openingCash);
    const wcDelta: AmountBreakdown = subtractBreakdown(cashDelta, netIncome);
    const operatingAdjustments: LineItem[] = [
      { accountCode: '__working_capital_delta', accountName: '운전자본 변동', amount: wcDelta },
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
      metadata: buildMetadata(uncertainCount),
    });
  }

  private previousDay(date: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
}

export const _exportsForTypeCheck = { zeroBreakdown };
