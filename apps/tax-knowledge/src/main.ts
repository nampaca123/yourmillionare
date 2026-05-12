// Dependency wiring: assembles ports, use-cases, and controllers for the Tax-Knowledge Lambda.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { BedrockKbClient } from './infrastructure/outbound/bedrock/bedrock-kb.client.js';
import { PgKbStalenessReader } from './infrastructure/outbound/pg/pg-kb-staleness.reader.js';
import { SearchTaxLawUseCase } from './application/search-tax-law.use-case.js';
import { buildSearchTaxLawController } from './infrastructure/inbound/http/agent-tax-law.controller.js';
import { findBenefitsController } from './infrastructure/inbound/http/agent-find-benefits.controller.js';
import {
  adminTaxRulesController,
  adminApproveRuleController,
  adminRuleChangeLogController,
  adminSyncStateController,
  adminSyncRunController,
  adminListReviewsController,
  adminResolveReviewController,
} from './infrastructure/inbound/http/admin.controller.js';

export type Handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyResultV2> | APIGatewayProxyResultV2;

const kbClient = new BedrockKbClient();
const stalenessReader = new PgKbStalenessReader();
const searchTaxLaw = new SearchTaxLawUseCase(kbClient, stalenessReader);
const searchController = buildSearchTaxLawController(searchTaxLaw);

export const container = {
  routes: {
    'POST /tenants/{tenantId}/agent/search-tax-law': searchController,
    'POST /tenants/{tenantId}/agent/find-benefits': findBenefitsController,
    'GET /admin/tax-rules': adminTaxRulesController,
    'POST /admin/tax-rules/{id}/approve': adminApproveRuleController,
    'GET /admin/tax-rules/{id}/change-log': adminRuleChangeLogController,
    'GET /admin/tax-law-sync/state': adminSyncStateController,
    'POST /admin/tax-law-sync/run': adminSyncRunController,
    'GET /admin/tax-rule-reviews': adminListReviewsController,
    'POST /admin/tax-rule-reviews/{id}/resolve': adminResolveReviewController,
  } as Record<string, Handler>,
};
