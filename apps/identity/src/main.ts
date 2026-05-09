// Dependency wiring: assembles stateless ports, use-cases, and controllers in module scope.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import {
  IdempotencyAlreadyInProgressError,
  IdempotencyValidationError,
  makeIdempotent,
} from '@aws-lambda-powertools/idempotency';
import { IdempotencyInProgressError, IdempotencyKeyReusedError } from '@ym/shared-errors';
import { PgUserRepository } from './infrastructure/outbound/pg/pg-user.repository.js';
import { PgTenantRepository } from './infrastructure/outbound/pg/pg-tenant.repository.js';
import { PgTenantMemberRepository } from './infrastructure/outbound/pg/pg-tenant-member.repository.js';
import { KmsBizRegNoEncryptor } from './infrastructure/outbound/kms/kms-biz-reg-no.encryptor.js';
import { KmsBizRegNoHasher } from './infrastructure/outbound/kms/kms-biz-reg-no.hasher.js';
import { EnsureUserExistsUseCase } from './application/ensure-user-exists.use-case.js';
import { CreateTenantUseCase } from './application/create-tenant.use-case.js';
import { ListMyTenantsUseCase } from './application/list-my-tenants.use-case.js';
import { healthController } from './infrastructure/inbound/http/health.controller.js';
import { buildMeController } from './infrastructure/inbound/http/me.controller.js';
import {
  buildCreateTenantController,
  buildListMyTenantsController,
} from './infrastructure/inbound/http/tenant.controller.js';
import { buildPersistenceStore, buildIdempotencyConfig } from './infrastructure/inbound/http/idempotency.config.js';

export type Handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyResultV2> | APIGatewayProxyResultV2;

const kmsBizRegKeyArn = process.env.KMS_BIZREG_KEY_ARN ?? '';
const kmsHmacKeyArn = process.env.KMS_BIZREG_HMAC_KEY_ARN ?? '';

const userRepo = new PgUserRepository();
const tenantRepo = new PgTenantRepository();
const memberRepo = new PgTenantMemberRepository();

const encryptor = new KmsBizRegNoEncryptor(kmsBizRegKeyArn);
const hasher = new KmsBizRegNoHasher(kmsHmacKeyArn);

const ensureUser = new EnsureUserExistsUseCase(userRepo);
const createTenant = new CreateTenantUseCase(tenantRepo, memberRepo, encryptor, hasher);
const listTenants = new ListMyTenantsUseCase(tenantRepo);

const tenantCreatePersistence = buildPersistenceStore('tenant-create');
const tenantCreateIdempotencyConfig = buildIdempotencyConfig('headers."idempotency-key"');

export const registerIdentityPowertoolsContext = (lambdaContext: Context): void => {
  tenantCreateIdempotencyConfig.registerLambdaContext(lambdaContext);
};

const idempotentCreateTenant = makeIdempotent(buildCreateTenantController(ensureUser, createTenant), {
  persistenceStore: tenantCreatePersistence,
  config: tenantCreateIdempotencyConfig,
});

const createTenantWithIdempotencyMapped: Handler = async (event) => {
  try {
    return await idempotentCreateTenant(event);
  } catch (err) {
    if (err instanceof IdempotencyValidationError) throw new IdempotencyKeyReusedError();
    if (err instanceof IdempotencyAlreadyInProgressError) throw new IdempotencyInProgressError();
    throw err;
  }
};

export const container = {
  routes: {
    'GET /health': healthController,
    'GET /me': buildMeController(ensureUser),
    'POST /tenants': createTenantWithIdempotencyMapped,
    'GET /me/tenants': buildListMyTenantsController(ensureUser, listTenants),
  } as Record<string, Handler>,
};
