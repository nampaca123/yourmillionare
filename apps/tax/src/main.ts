// Dependency wiring: assembles ports, use-cases, and controllers for the Tax Lambda.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { PgCorporationProfileRepository } from './infrastructure/outbound/pg/pg-corporation-profile.repository.js';
import {
  buildGetCorporationProfileController,
  buildUpsertCorporationProfileController,
} from './infrastructure/inbound/http/corporation-profile.controller.js';
import {
  filingsUpcomingController,
  filingDraftController,
  filingPenaltySimulationController,
  filingRecomputeController,
} from './infrastructure/inbound/http/filings.controller.js';
import {
  withholdingPendingController,
  withholdingFileController,
} from './infrastructure/inbound/http/withholding.controller.js';
import { taxInvoicesController } from './infrastructure/inbound/http/tax-invoices.controller.js';

export type Handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyResultV2> | APIGatewayProxyResultV2;

const profileRepo = new PgCorporationProfileRepository();

const getProfile = buildGetCorporationProfileController(profileRepo);
const upsertProfile = buildUpsertCorporationProfileController(profileRepo);

export const container = {
  routes: {
    'GET /tenants/{tenantId}/corporation-profile': getProfile,
    'POST /tenants/{tenantId}/corporation-profile': upsertProfile,
    'GET /tenants/{tenantId}/filings/upcoming': filingsUpcomingController,
    'GET /tenants/{tenantId}/filings/{id}/draft': filingDraftController,
    'GET /tenants/{tenantId}/filings/{id}/penalty-simulation': filingPenaltySimulationController,
    'POST /tenants/{tenantId}/filings/{id}/recompute': filingRecomputeController,
    'GET /tenants/{tenantId}/withholding/pending': withholdingPendingController,
    'POST /tenants/{tenantId}/withholding/{id}/file': withholdingFileController,
    'GET /tenants/{tenantId}/tax-invoices': taxInvoicesController,
  } as Record<string, Handler>,
};
