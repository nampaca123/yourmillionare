// Controller: POST /tenants/{tenantId}/agent/search-tax-law — wraps the SearchTaxLawUseCase.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { ValidationError } from '@ym/shared-errors';
import type { SearchTaxLawUseCase } from '../../../application/search-tax-law.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';

const BodySchema = z.object({
  query: z.string().min(1).max(500),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lawId: z.string().optional(),
  lawType: z.enum(['LAW', 'DECREE', 'REGULATION', 'INTERPRETATION', 'BYLAW']).optional(),
});

export const buildSearchTaxLawController =
  (useCase: SearchTaxLawUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    parseClaims(event.requestContext.authorizer.jwt.claims);
    if (!event.body) throw new ValidationError('Request body is required');
    let body: unknown;
    try {
      body = JSON.parse(event.body);
    } catch {
      throw new ValidationError('Body is not valid JSON');
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) throw new ZodError(parsed.error.issues);
    const input: Parameters<typeof useCase.execute>[0] = {
      query: parsed.data.query,
      ...(parsed.data.asOfDate !== undefined ? { asOfDate: parsed.data.asOfDate } : {}),
      ...(parsed.data.lawId !== undefined ? { lawId: parsed.data.lawId } : {}),
      ...(parsed.data.lawType !== undefined ? { lawType: parsed.data.lawType } : {}),
    };
    const result = await useCase.execute(input);
    return { statusCode: 200, body: JSON.stringify(result) };
  };
