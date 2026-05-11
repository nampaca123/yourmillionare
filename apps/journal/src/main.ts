// Dependency wiring: assembles stateless ports, use-cases, and controllers for the journal Lambda.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import {
  IdempotencyAlreadyInProgressError,
  IdempotencyValidationError,
  makeIdempotent,
} from '@aws-lambda-powertools/idempotency';
import { IdempotencyInProgressError, IdempotencyKeyReusedError } from '@ym/shared-errors';
import { PgUserRepository } from './infrastructure/outbound/pg/pg-user.repository.js';
import { PgTenantMemberRepository } from './infrastructure/outbound/pg/pg-tenant-member.repository.js';
import { PgAccountRepository } from './infrastructure/outbound/pg/pg-account.repository.js';
import { PgJournalRepository } from './infrastructure/outbound/pg/pg-journal.repository.js';
import { PgSyncStateRepository } from './infrastructure/outbound/pg/pg-sync-state.repository.js';
import { PgViewsRepository } from './infrastructure/outbound/pg/pg-views.repository.js';
import { PgReportsRepository } from './infrastructure/outbound/pg/pg-reports.repository.js';
import { SfnSyncDispatcher } from './infrastructure/outbound/sfn/sfn-sync-dispatcher.adapter.js';
import { DdbCostCounterAdapter } from './infrastructure/outbound/ddb/ddb-cost-counter.adapter.js';
import { BedrockConverseClassifier, DeterministicStubClassifier, DdbCacheProjectorAdapter } from '@ym/journal-core';
import { EnsureUserExistsUseCase } from './application/ensure-user-exists.use-case.js';
import { VerifyTenantMembershipUseCase } from './application/verify-tenant-membership.use-case.js';
import { EnsureAccountsSeededUseCase } from './application/ensure-accounts-seeded.use-case.js';
import { ClassifyTransactionUseCase } from './application/classify-transaction.use-case.js';
import { CreateJournalEntryUseCase } from './application/create-journal-entry.use-case.js';
import { ListJournalEntriesUseCase } from './application/list-journal-entries.use-case.js';
import { StartTenantSyncUseCase } from './application/start-tenant-sync.use-case.js';
import { GetSyncStatusUseCase } from './application/get-sync-status.use-case.js';
import { GetMonthlySummaryUseCase } from './application/get-monthly-summary.use-case.js';
import { GetReceivablesUseCase, UpdateReceivableStatusUseCase } from './application/get-receivables.use-case.js';
import { GetAccountBalancesUseCase } from './application/get-account-balances.use-case.js';
import { ListDraftsUseCase } from './application/list-drafts.use-case.js';
import {
  BuildBalanceSheetUseCase,
  BuildCashFlowUseCase,
  BuildIncomeStatementUseCase,
  BuildTrialBalanceUseCase,
} from './application/build-reports.use-case.js';
import { buildClassifyController } from './infrastructure/inbound/http/classify.controller.js';
import { buildCreateEntryController } from './infrastructure/inbound/http/create-entry.controller.js';
import { buildListEntriesController } from './infrastructure/inbound/http/list-entries.controller.js';
import { buildSyncStartController } from './infrastructure/inbound/http/sync-start.controller.js';
import { buildSyncStatusController } from './infrastructure/inbound/http/sync-status.controller.js';
import {
  buildAccountBalancesController,
  buildListDraftsController,
  buildMonthlySummaryController,
  buildReceivablesController,
  buildUpdateReceivableController,
} from './infrastructure/inbound/http/core-views.controller.js';
import {
  buildBalanceSheetController,
  buildCashFlowController,
  buildPnlController,
  buildTrialBalanceController,
} from './infrastructure/inbound/http/reports.controller.js';
import { accountsChartController } from './infrastructure/inbound/http/accounts-chart.controller.js';
import { buildPersistenceStore, buildIdempotencyConfig } from './infrastructure/inbound/http/idempotency.config.js';

export type Handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyResultV2> | APIGatewayProxyResultV2;

const DAILY_LIMIT = parseInt(process.env.BEDROCK_DAILY_LIMIT_PER_USER ?? '100', 10);

const userRepo = new PgUserRepository();
const memberRepo = new PgTenantMemberRepository();
const accountRepo = new PgAccountRepository();
const journalRepo = new PgJournalRepository();
const syncStateRepo = new PgSyncStateRepository();
const viewsRepo = new PgViewsRepository();
const reportsRepo = new PgReportsRepository();
const syncDispatcher = new SfnSyncDispatcher();
const costCounter = new DdbCostCounterAdapter();
const useStubClassifier =
  process.env.JOURNAL_STUB_CLASSIFIER === '1' || process.env.JOURNAL_STUB_CLASSIFIER === 'true';
const classifier = useStubClassifier ? new DeterministicStubClassifier() : new BedrockConverseClassifier();

const cacheProjector = new DdbCacheProjectorAdapter();

const ensureUser = new EnsureUserExistsUseCase(userRepo);
const verifyMembership = new VerifyTenantMembershipUseCase(memberRepo);
const ensureSeeded = new EnsureAccountsSeededUseCase(accountRepo);
const classifyTransaction = new ClassifyTransactionUseCase(classifier, journalRepo, costCounter, DAILY_LIMIT);
const createEntry = new CreateJournalEntryUseCase(journalRepo, accountRepo, cacheProjector);
const listEntries = new ListJournalEntriesUseCase(verifyMembership, journalRepo);
const startTenantSync = new StartTenantSyncUseCase(verifyMembership, syncDispatcher);
const getSyncStatus = new GetSyncStatusUseCase(verifyMembership, syncStateRepo);
const getMonthlySummary = new GetMonthlySummaryUseCase(verifyMembership, viewsRepo);
const getReceivables = new GetReceivablesUseCase(verifyMembership, viewsRepo);
const updateReceivable = new UpdateReceivableStatusUseCase(verifyMembership, viewsRepo);
const getAccountBalances = new GetAccountBalancesUseCase(verifyMembership, viewsRepo);
const listDrafts = new ListDraftsUseCase(verifyMembership, viewsRepo);
const buildPnl = new BuildIncomeStatementUseCase(verifyMembership, reportsRepo);
const buildBs = new BuildBalanceSheetUseCase(verifyMembership, reportsRepo);
const buildTb = new BuildTrialBalanceUseCase(verifyMembership, reportsRepo);
const buildCf = new BuildCashFlowUseCase(verifyMembership, reportsRepo);

const classifyController = buildClassifyController(ensureUser, verifyMembership, ensureSeeded, classifyTransaction);
const createEntryController = buildCreateEntryController(ensureUser, verifyMembership, ensureSeeded, createEntry);
const listEntriesController = buildListEntriesController(ensureUser, listEntries);
const syncStartController = buildSyncStartController(ensureUser, startTenantSync);
const syncStatusController = buildSyncStatusController(ensureUser, getSyncStatus);
const monthlySummaryController = buildMonthlySummaryController(ensureUser, getMonthlySummary);
const receivablesController = buildReceivablesController(ensureUser, getReceivables);
const updateReceivableController = buildUpdateReceivableController(ensureUser, updateReceivable);
const balancesController = buildAccountBalancesController(ensureUser, getAccountBalances);
const draftsController = buildListDraftsController(ensureUser, listDrafts);
const pnlController = buildPnlController(ensureUser, buildPnl);
const balanceSheetController = buildBalanceSheetController(ensureUser, buildBs);
const trialBalanceController = buildTrialBalanceController(ensureUser, buildTb);
const cashFlowController = buildCashFlowController(ensureUser, buildCf);

const classifyPersistence = buildPersistenceStore('journal-classify');
const classifyIdempotencyConfig = buildIdempotencyConfig(
  'headers."idempotency-key" || body',
);
const syncPersistence = buildPersistenceStore('journal-sync');
const syncIdempotencyConfig = buildIdempotencyConfig('headers."idempotency-key"');

export const registerJournalPowertoolsContext = (lambdaContext: Context): void => {
  classifyIdempotencyConfig.registerLambdaContext(lambdaContext);
  syncIdempotencyConfig.registerLambdaContext(lambdaContext);
};

const wrapIdempotent = (controller: Handler, persistence: ReturnType<typeof buildPersistenceStore>, config: ReturnType<typeof buildIdempotencyConfig>): Handler => {
  const idempotent = makeIdempotent(controller, { persistenceStore: persistence, config });
  return async (event) => {
    try {
      return await idempotent(event);
    } catch (err) {
      if (err instanceof IdempotencyValidationError) throw new IdempotencyKeyReusedError();
      if (err instanceof IdempotencyAlreadyInProgressError) throw new IdempotencyInProgressError();
      throw err;
    }
  };
};

const classifyWithIdempotencyMapped = wrapIdempotent(classifyController, classifyPersistence, classifyIdempotencyConfig);
const syncStartWithIdempotencyMapped = wrapIdempotent(syncStartController, syncPersistence, syncIdempotencyConfig);

export const container = {
  routes: {
    'GET /accounts/chart': accountsChartController as Handler,
    'POST /tenants/{tenantId}/journal/classify': classifyWithIdempotencyMapped,
    'POST /tenants/{tenantId}/journal/entries': createEntryController,
    'GET /tenants/{tenantId}/journal/entries': listEntriesController,
    'GET /tenants/{tenantId}/journal/drafts': draftsController,
    'POST /tenants/{tenantId}/sync': syncStartWithIdempotencyMapped,
    'GET /tenants/{tenantId}/sync/status': syncStatusController,
    'GET /tenants/{tenantId}/summary/monthly': monthlySummaryController,
    'GET /tenants/{tenantId}/receivables': receivablesController,
    'PATCH /tenants/{tenantId}/receivables/{entryId}': updateReceivableController,
    'GET /tenants/{tenantId}/accounts/balances': balancesController,
    'GET /tenants/{tenantId}/reports/pnl': pnlController,
    'GET /tenants/{tenantId}/reports/balance-sheet': balanceSheetController,
    'GET /tenants/{tenantId}/reports/cash-flow': cashFlowController,
    'GET /tenants/{tenantId}/reports/trial-balance': trialBalanceController,
  } as Record<string, Handler>,
};
