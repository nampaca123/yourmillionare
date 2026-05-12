// Controllers: GET /sync/runs/{syncRunId}, GET /sync/runs?limit=, GET /sync/runs/latest — surfaces async sync outcomes for FE polling.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ValidationError } from '@ym/shared-errors';
import type { EnsureUserExistsUseCase } from '../../../application/ensure-user-exists.use-case.js';
import type {
  GetLatestSyncRunUseCase,
  GetSyncRunUseCase,
  ListSyncRunsUseCase,
} from '../../../application/get-sync-run.use-case.js';
import { parseClaims } from './auth-claims.mapper.js';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

export const buildGetSyncRunController =
  (ensureUser: EnsureUserExistsUseCase, getRun: GetSyncRunUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';
    const syncRunId = event.pathParameters?.syncRunId ?? '';

    if (!syncRunId) {
      throw new ValidationError('syncRunId path parameter is required');
    }

    const detail = await getRun.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      syncRunId,
    });

    return { statusCode: 200, body: JSON.stringify(detail) };
  };

export const buildListSyncRunsController =
  (ensureUser: EnsureUserExistsUseCase, listRuns: ListSyncRunsUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';

    const rawLimit = event.queryStringParameters?.limit;
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : DEFAULT_LIST_LIMIT;
    if (rawLimit !== undefined && (Number.isNaN(parsedLimit) || parsedLimit < 1)) {
      throw new ValidationError('limit must be a positive integer');
    }
    const limit = Math.min(parsedLimit, MAX_LIST_LIMIT);

    const runs = await listRuns.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
      limit,
    });

    return { statusCode: 200, body: JSON.stringify({ runs }) };
  };

export const buildLatestSyncRunController =
  (ensureUser: EnsureUserExistsUseCase, getLatest: GetLatestSyncRunUseCase) =>
  async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
    const user = await ensureUser.execute({ cognitoSub: claims.cognitoSub, email: claims.email });
    const tenantId = event.pathParameters?.tenantId ?? '';

    const detail = await getLatest.execute({
      tenantId,
      userId: user.id,
      cognitoSub: claims.cognitoSub,
    });

    if (!detail) {
      return { statusCode: 200, body: JSON.stringify({ run: null, accounts: [] }) };
    }

    return { statusCode: 200, body: JSON.stringify(detail) };
  };
