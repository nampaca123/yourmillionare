// Controller: POST /tenants/{tenantId}/agent/find-benefits — stubs the corporation-profile-driven benefits search until Wave-5.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { ValidationError } from '@ym/shared-errors';
import type { FindApplicableBenefitsUseCase } from '../../../application/find-applicable-benefits.use-case.js';
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

export const buildFindBenefitsController =
  (useCase: FindApplicableBenefitsUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    parseClaims(event.requestContext.authorizer.jwt.claims);
    const tenantId = event.pathParameters?.tenantId ?? '';
    if (!event.body) throw new ValidationError('Request body is required');
    let body: unknown;
    try {
      body = JSON.parse(event.body);
    } catch {
      throw new ValidationError('Body is not valid JSON');
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) throw new ZodError(parsed.error.issues);
    const profile = parsed.data.corpProfile ?? {
      industryCode: '',
      foundedAt: '',
      isYouthFounder: false,
      hqSigungu: '',
      priorYearRevenue: 0,
    };
    const result = await useCase.execute({
      tenantId,
      asOfDate: parsed.data.asOfDate,
      profile: {
        industryCode: profile.industryCode || null,
        foundedAt: profile.foundedAt || null,
        isYouthFounder: profile.isYouthFounder,
        hqSigungu: profile.hqSigungu || null,
        priorYearCorpTax: null,
      },
    });
    return { statusCode: 200, body: JSON.stringify(result) };
  };
