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
import { DdbCostCounterAdapter } from './infrastructure/outbound/ddb/ddb-cost-counter.adapter.js';
import { BedrockConverseClassifier, DeterministicStubClassifier, DdbCacheProjectorAdapter } from '@ym/journal-core';
import { EnsureUserExistsUseCase } from './application/ensure-user-exists.use-case.js';
import { VerifyTenantMembershipUseCase } from './application/verify-tenant-membership.use-case.js';
import { EnsureAccountsSeededUseCase } from './application/ensure-accounts-seeded.use-case.js';
import { ClassifyTransactionUseCase } from './application/classify-transaction.use-case.js';
import { CreateJournalEntryUseCase } from './application/create-journal-entry.use-case.js';
import { ListJournalEntriesUseCase } from './application/list-journal-entries.use-case.js';
import { buildClassifyController } from './infrastructure/inbound/http/classify.controller.js';
import { buildCreateEntryController } from './infrastructure/inbound/http/create-entry.controller.js';
import { buildListEntriesController } from './infrastructure/inbound/http/list-entries.controller.js';
import { buildPersistenceStore, buildIdempotencyConfig } from './infrastructure/inbound/http/idempotency.config.js';

export type Handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyResultV2> | APIGatewayProxyResultV2;

const DAILY_LIMIT = parseInt(process.env.BEDROCK_DAILY_LIMIT_PER_USER ?? '100', 10);

const userRepo = new PgUserRepository();
const memberRepo = new PgTenantMemberRepository();
const accountRepo = new PgAccountRepository();
const journalRepo = new PgJournalRepository();
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

const classifyController = buildClassifyController(ensureUser, verifyMembership, ensureSeeded, classifyTransaction);
const createEntryController = buildCreateEntryController(ensureUser, verifyMembership, ensureSeeded, createEntry);
const listEntriesController = buildListEntriesController(ensureUser, listEntries);

const classifyPersistence = buildPersistenceStore('journal-classify');
const classifyIdempotencyConfig = buildIdempotencyConfig(
  // HTTP API lowercases headers; body is unparsed JSON string — avoid JMES join on nested nulls.
  'headers."idempotency-key" || body',
);

export const registerJournalPowertoolsContext = (lambdaContext: Context): void => {
  classifyIdempotencyConfig.registerLambdaContext(lambdaContext);
};

const idempotentClassify = makeIdempotent(classifyController, {
  persistenceStore: classifyPersistence,
  config: classifyIdempotencyConfig,
});

const classifyWithIdempotencyMapped: Handler = async (event) => {
  try {
    return await idempotentClassify(event);
  } catch (err) {
    if (err instanceof IdempotencyValidationError) throw new IdempotencyKeyReusedError();
    if (err instanceof IdempotencyAlreadyInProgressError) throw new IdempotencyInProgressError();
    throw err;
  }
};

export const container = {
  routes: {
    'POST /tenants/{tenantId}/journal/classify': classifyWithIdempotencyMapped,
    'POST /tenants/{tenantId}/journal/entries': createEntryController,
    'GET /tenants/{tenantId}/journal/entries': listEntriesController,
  } as Record<string, Handler>,
};
