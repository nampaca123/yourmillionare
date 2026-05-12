// Controllers: GET/POST /tenants/{tenantId}/corporation-profile — reads and updates extended tenant fields.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { NotFoundError, ValidationError } from '@ym/shared-errors';
import type { PgCorporationProfileRepository } from '../../outbound/pg/pg-corporation-profile.repository.js';
import { parseClaims } from './auth-claims.mapper.js';

const UpsertSchema = z.object({
  foundedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  regionCode: z.string().min(1).max(20).optional(),
  industryCode: z.string().min(1).max(10).optional(),
  isYouthFounder: z.boolean().optional(),
  isVentureCertified: z.boolean().optional(),
  isExternalAudit: z.boolean().optional(),
  vatPrepaymentRecipient: z.boolean().optional(),
  withholdingCadence: z.enum(['MONTHLY', 'SEMIANNUAL']).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  priorYearCorpTax: z.number().nonnegative().optional(),
  priorYearRevenue: z.number().nonnegative().optional(),
});

export const buildGetCorporationProfileController =
  (repo: PgCorporationProfileRepository) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const tenantId = event.pathParameters?.tenantId ?? '';
    const profile = await repo.find({ tenantId, cognitoSub: claims.cognitoSub, userId: '' });
    if (!profile) throw new NotFoundError('Corporation profile not found');
    return { statusCode: 200, body: JSON.stringify(profile) };
  };

export const buildUpsertCorporationProfileController =
  (repo: PgCorporationProfileRepository) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const tenantId = event.pathParameters?.tenantId ?? '';
    if (!event.body) throw new ValidationError('Request body is required');
    let body: unknown;
    try {
      body = JSON.parse(event.body);
    } catch {
      throw new ValidationError('Body is not valid JSON');
    }
    const parsed = UpsertSchema.safeParse(body);
    if (!parsed.success) throw new ZodError(parsed.error.issues);
    const upsertInput: Parameters<typeof repo.upsert>[0] = {
      tenantId,
      cognitoSub: claims.cognitoSub,
      userId: '',
    };
    if (parsed.data.foundedOn !== undefined) upsertInput.foundedOn = parsed.data.foundedOn;
    if (parsed.data.regionCode !== undefined) upsertInput.regionCode = parsed.data.regionCode;
    if (parsed.data.industryCode !== undefined) upsertInput.industryCode = parsed.data.industryCode;
    if (parsed.data.isYouthFounder !== undefined) upsertInput.isYouthFounder = parsed.data.isYouthFounder;
    if (parsed.data.isVentureCertified !== undefined) upsertInput.isVentureCertified = parsed.data.isVentureCertified;
    if (parsed.data.isExternalAudit !== undefined) upsertInput.isExternalAudit = parsed.data.isExternalAudit;
    if (parsed.data.vatPrepaymentRecipient !== undefined) upsertInput.vatPrepaymentRecipient = parsed.data.vatPrepaymentRecipient;
    if (parsed.data.withholdingCadence !== undefined) upsertInput.withholdingCadence = parsed.data.withholdingCadence;
    if (parsed.data.fiscalYearStartMonth !== undefined) upsertInput.fiscalYearStartMonth = parsed.data.fiscalYearStartMonth;
    if (parsed.data.priorYearCorpTax !== undefined) upsertInput.priorYearCorpTax = parsed.data.priorYearCorpTax;
    if (parsed.data.priorYearRevenue !== undefined) upsertInput.priorYearRevenue = parsed.data.priorYearRevenue;
    const profile = await repo.upsert(upsertInput);
    return { statusCode: 201, body: JSON.stringify(profile) };
  };
