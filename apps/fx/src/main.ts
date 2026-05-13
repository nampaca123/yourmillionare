// Dependency wiring: assembles stateless ports, use-cases, and controllers for the FX HTTP Lambda behind a lazy async container.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { EcosExchangeRateClient } from './infrastructure/outbound/ecos/ecos-exchange-rate.client.js';
import { getEcosApiKey } from './infrastructure/outbound/ecos/ecos-secret.client.js';
import { PgFxObservationsRepository } from './infrastructure/outbound/pg/pg-fx-observations.repository.js';
import { GetExchangeRateUseCase } from './application/get-exchange-rate.use-case.js';
import { RevalueForeignBalancesUseCase } from './application/revalue-foreign-balances.use-case.js';
import { buildFxRatesController } from './infrastructure/inbound/http/fx-rates.controller.js';
import { buildFxRevalueController } from './infrastructure/inbound/http/fx-revalue.controller.js';
import {
  registerFxAccountController,
  listFxAccountsController,
  updateFxAccountBalanceController,
  deactivateFxAccountController,
  discoverFxAccountsController,
  linkFxAccountController,
} from './infrastructure/inbound/http/fx-accounts.controller.js';

export type Handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyResultV2> | APIGatewayProxyResultV2;

export interface Container {
  readonly routes: Record<string, Handler>;
}

let containerPromise: Promise<Container> | undefined;

const buildContainer = async (): Promise<Container> => {
  const apiKey = await getEcosApiKey();
  const ratesClient = new EcosExchangeRateClient({ apiKey });
  const cache = new PgFxObservationsRepository();
  const getRate = new GetExchangeRateUseCase(ratesClient, cache);
  const revalue = new RevalueForeignBalancesUseCase(ratesClient);
  return {
    routes: {
      'GET /fx/rates/usd-krw': buildFxRatesController(getRate),
      'POST /tenants/{tenantId}/fx/revalue': buildFxRevalueController(revalue),
      'POST /tenants/{tenantId}/fx/accounts': registerFxAccountController,
      'GET /tenants/{tenantId}/fx/accounts': listFxAccountsController,
      'GET /tenants/{tenantId}/fx/accounts/discoverable': discoverFxAccountsController,
      'POST /tenants/{tenantId}/fx/accounts/link': linkFxAccountController,
      'PATCH /tenants/{tenantId}/fx/accounts/{accountId}/balance': updateFxAccountBalanceController,
      'DELETE /tenants/{tenantId}/fx/accounts/{accountId}': deactivateFxAccountController,
    },
  };
};

export const getContainer = (): Promise<Container> => {
  if (!containerPromise) containerPromise = buildContainer();
  return containerPromise;
};
