// Lambda entry: scheduled FX collector — wires ECOS client + Aurora observations writer into CollectFxRatesUseCase.

import { CollectFxRatesUseCase, type CollectFxRatesResult } from '../../application/collect-fx-rates.use-case.js';
import { EcosExchangeRateClient } from '../outbound/ecos/ecos-exchange-rate.client.js';
import { getEcosApiKey } from '../outbound/ecos/ecos-secret.client.js';
import { PgFxObservationsRepository } from '../outbound/pg/pg-fx-observations.repository.js';
import { logger } from '../../shared/logging/logger.js';

let useCasePromise: Promise<CollectFxRatesUseCase> | undefined;

const buildUseCase = async (): Promise<CollectFxRatesUseCase> => {
  const apiKey = await getEcosApiKey();
  const client = new EcosExchangeRateClient({ apiKey });
  const writer = new PgFxObservationsRepository();
  return new CollectFxRatesUseCase(client, writer);
};

const getUseCase = (): Promise<CollectFxRatesUseCase> => {
  if (!useCasePromise) useCasePromise = buildUseCase();
  return useCasePromise;
};

export const handler = async (): Promise<CollectFxRatesResult> => {
  const log = logger.child({ lambda: 'fx-collector' });
  const useCase = await getUseCase();
  const result = await useCase.execute();
  log.info({ ...result }, 'fx-observations upserted');
  return result;
};
