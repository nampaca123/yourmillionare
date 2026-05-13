// Dependency wiring: assembles ports, use-cases, and controllers for the Tax-Knowledge Lambda (admin only — agent-* tool endpoints live in apps/tax).

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
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

export const container = {
  routes: {
    'GET /admin/tax-rules': adminTaxRulesController,
    'POST /admin/tax-rules/{id}/approve': adminApproveRuleController,
    'GET /admin/tax-rules/{id}/change-log': adminRuleChangeLogController,
    'GET /admin/tax-law-sync/state': adminSyncStateController,
    'POST /admin/tax-law-sync/run': adminSyncRunController,
    'GET /admin/tax-rule-reviews': adminListReviewsController,
    'POST /admin/tax-rule-reviews/{id}/resolve': adminResolveReviewController,
  } as Record<string, Handler>,
};
