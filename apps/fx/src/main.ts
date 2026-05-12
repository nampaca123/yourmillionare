// Dependency wiring: assembles stateless ports, use-cases, and controllers for the FX Lambda.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { EcosExchangeRateClient } from './infrastructure/outbound/ecos/ecos-exchange-rate.client.js';
import { PgFxObservationsRepository } from './infrastructure/outbound/pg/pg-fx-observations.repository.js';
import { GetExchangeRateUseCase } from './application/get-exchange-rate.use-case.js';
import { RevalueForeignBalancesUseCase } from './application/revalue-foreign-balances.use-case.js';
import { buildFxRatesController } from './infrastructure/inbound/http/fx-rates.controller.js';
import { buildFxRevalueController } from './infrastructure/inbound/http/fx-revalue.controller.js';

export type Handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyResultV2> | APIGatewayProxyResultV2;

const ecosKey = process.env.ECOS_API_KEY ?? '';
const ratesClient = new EcosExchangeRateClient({ apiKey: ecosKey });
const cache = new PgFxObservationsRepository();
const getRate = new GetExchangeRateUseCase(ratesClient, cache);
const revalue = new RevalueForeignBalancesUseCase(ratesClient);

const ratesController = buildFxRatesController(getRate);
const revalueController = buildFxRevalueController(revalue);

export const container = {
  routes: {
    'GET /fx/rates/usd-krw': ratesController,
    'POST /tenants/{tenantId}/fx/revalue': revalueController,
  } as Record<string, Handler>,
};
