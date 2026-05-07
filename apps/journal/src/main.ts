// Dependency wiring: assembles stateless ports, use-cases, and controllers for the journal Lambda.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { makeIdempotent } from '@aws-lambda-powertools/idempotency';
import { PgUserRepository } from './infrastructure/outbound/pg/pg-user.repository.js';
import { PgTenantMemberRepository } from './infrastructure/outbound/pg/pg-tenant-member.repository.js';
import { PgAccountRepository } from './infrastructure/outbound/pg/pg-account.repository.js';
import { PgJournalRepository } from './infrastructure/outbound/pg/pg-journal.repository.js';
import { DdbCostCounterAdapter } from './infrastructure/outbound/ddb/ddb-cost-counter.adapter.js';
import { BedrockConverseClassifier } from './infrastructure/outbound/bedrock/bedrock-converse.classifier.js';
import { EnsureUserExistsUseCase } from './application/ensure-user-exists.use-case.js';
import { VerifyTenantMembershipUseCase } from './application/verify-tenant-membership.use-case.js';
import { EnsureAccountsSeededUseCase } from './application/ensure-accounts-seeded.use-case.js';
import { ClassifyTransactionUseCase } from './application/classify-transaction.use-case.js';
import { CreateJournalEntryUseCase } from './application/create-journal-entry.use-case.js';
import { buildClassifyController } from './infrastructure/inbound/http/classify.controller.js';
import { buildCreateEntryController } from './infrastructure/inbound/http/create-entry.controller.js';
import { buildPersistenceStore, buildIdempotencyConfig } from './infrastructure/inbound/http/idempotency.config.js';

export type Handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyResultV2> | APIGatewayProxyResultV2;

const DAILY_LIMIT = parseInt(process.env.BEDROCK_DAILY_LIMIT_PER_USER ?? '100', 10);

const userRepo = new PgUserRepository();
const memberRepo = new PgTenantMemberRepository();
const accountRepo = new PgAccountRepository();
const journalRepo = new PgJournalRepository();
const costCounter = new DdbCostCounterAdapter();
const classifier = new BedrockConverseClassifier();

const ensureUser = new EnsureUserExistsUseCase(userRepo);
const verifyMembership = new VerifyTenantMembershipUseCase(memberRepo);
const ensureSeeded = new EnsureAccountsSeededUseCase(accountRepo);
const classifyTransaction = new ClassifyTransactionUseCase(classifier, journalRepo, costCounter, DAILY_LIMIT);
const createEntry = new CreateJournalEntryUseCase(journalRepo);

const classifyController = buildClassifyController(ensureUser, verifyMembership, ensureSeeded, classifyTransaction);
const createEntryController = buildCreateEntryController(ensureUser, verifyMembership, createEntry);

const classifyPersistence = buildPersistenceStore('journal-classify');
const classifyIdempotencyConfig = buildIdempotencyConfig(
  'headers."Idempotency-Key" || ' +
  "[body.date, to_string(body.amount), body.counterparty, body.memo] | join('#', @)",
);

export const container = {
  routes: {
    'POST /tenants/{tenantId}/journal/classify': makeIdempotent(classifyController, {
      persistenceStore: classifyPersistence,
      config: classifyIdempotencyConfig,
    }),
    'POST /tenants/{tenantId}/journal/entries': createEntryController,
  } as Record<string, Handler>,
};
