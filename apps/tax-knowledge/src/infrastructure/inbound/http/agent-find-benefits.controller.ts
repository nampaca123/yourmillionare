// Controller: POST /tenants/{tenantId}/agent/find-benefits — stubs the corporation-profile-driven benefits search until Wave-5.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { ValidationError } from '@ym/shared-errors';
import { parseClaims } from './auth-claims.mapper.js';

const BodySchema = z.object({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  corpProfile: z
    .object({
      industryCode: z.string(),
      foundedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      isYouthFounder: z.boolean(),
      hqSigungu: z.string(),
      priorYearRevenue: z.number().nonnegative(),
      isVentureCertified: z.boolean().optional(),
      isExternalAudit: z.boolean().optional(),
    })
    .optional(),
});

const DISCLAIMER = '본 산정은 추정치이며 실제 적용은 세무사 확인이 필요합니다.';

export const findBenefitsController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
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

  return {
    statusCode: 200,
    body: JSON.stringify({
      benefits: [],
      asOfDate: parsed.data.asOfDate,
      totalEstimatedSavings: { amount: 0, currency: 'KRW' },
      disclaimer: DISCLAIMER,
      verification: { cacheHit: false, kbStale: false, lastSyncedAt: null },
      pending: 'Wave-5: keyword extraction from corpProfile + KB retrieve (lawId=조세특례제한법) + rule-engine eligibility + Code Interpreter savings calc',
    }),
  };
};
