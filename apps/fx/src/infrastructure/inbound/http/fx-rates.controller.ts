// Controller: GET /fx/rates/usd-krw — single date or date range, ECOS-backed with PgFxObservations cache.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { ValidationError } from '@ym/shared-errors';
import type { GetExchangeRateUseCase } from '../../../application/get-exchange-rate.use-case.js';

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SingleSchema = z.object({ date: DateOnly });
const RangeSchema = z.object({ from: DateOnly, to: DateOnly });

export const buildFxRatesController =
  (useCase: GetExchangeRateUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const q = event.queryStringParameters ?? {};
    if (q.date) {
      const parsed = SingleSchema.safeParse(q);
      if (!parsed.success) throw new ZodError(parsed.error.issues);
      const rate = await useCase.getRate({ quoteCurrency: 'USD', date: parsed.data.date });
      return { statusCode: 200, body: JSON.stringify(rate) };
    }
    if (q.from && q.to) {
      const parsed = RangeSchema.safeParse(q);
      if (!parsed.success) throw new ZodError(parsed.error.issues);
      const rates = await useCase.getRange({
        quoteCurrency: 'USD',
        fromDate: parsed.data.from,
        toDate: parsed.data.to,
      });
      return { statusCode: 200, body: JSON.stringify({ rates }) };
    }
    throw new ValidationError('Either ?date= or ?from= and ?to= is required');
  };
