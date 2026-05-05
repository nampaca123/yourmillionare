// Tenant controllers: create tenant and list user's tenants.
// POST /tenants Idempotency-Key deferred to Slice 4 (see docs/03-identity-api.ko.md).

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type { CreateTenantUseCase } from '../../../application/create-tenant.use-case.js';
import type { ListMyTenantsUseCase } from '../../../application/list-my-tenants.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';
import { CreateTenantBodySchema } from './create-tenant.schema.js';
import { ValidationError } from '../../../shared/errors/app-error.js';

export const buildCreateTenantController =
  (ensureUser: EnsureUserExistsUseCase, createTenant: CreateTenantUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });

    let body: unknown;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      throw new ValidationError('Request body is not valid JSON');
    }

    const parsed = CreateTenantBodySchema.safeParse(body);
    if (!parsed.success) throw new ZodError(parsed.error.issues);

    const { tenant } = await createTenant.execute({
      userId: user.id,
      legalName: parsed.data.legalName,
      displayName: parsed.data.displayName,
      bizRegNoRaw: parsed.data.bizRegNo,
    });

    return {
      statusCode: 201,
      body: JSON.stringify({ id: tenant.id, legalName: tenant.legalName, displayName: tenant.displayName }),
    };
  };

export const buildListMyTenantsController =
  (ensureUser: EnsureUserExistsUseCase, listTenants: ListMyTenantsUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });

    const tenants = await listTenants.execute({ userId: user.id });

    return {
      statusCode: 200,
      body: JSON.stringify(tenants.map((t) => ({ id: t.id, legalName: t.legalName, displayName: t.displayName }))),
    };
  };
