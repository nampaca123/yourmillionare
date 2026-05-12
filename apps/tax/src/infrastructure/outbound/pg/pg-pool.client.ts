// IAM-authenticated pg.Pool with token caching (mirror of apps/journal pattern).

import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';

const TOKEN_TTL_MS = 15 * 60 * 1000;
const REFRESH_BEFORE_MS = 3 * 60 * 1000;

const hostname = process.env.CLUSTER_ENDPOINT ?? '';
const port = parseInt(process.env.CLUSTER_PORT ?? '5432', 10);
const database = process.env.DATABASE_NAME ?? 'yourmillionare';
const region = process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2';

let pool: Pool | undefined;
let tokenIssuedAt = 0;
let refreshing: Promise<Pool> | undefined;

const isExpired = (): boolean => Date.now() - tokenIssuedAt > TOKEN_TTL_MS - REFRESH_BEFORE_MS;

const doRefresh = async (): Promise<Pool> => {
  if (pool) await pool.end().catch(() => undefined);
  const token = await new Signer({ hostname, port, username: 'app_user', region }).getAuthToken();
  pool = new Pool({
    host: hostname,
    port,
    user: 'app_user',
    password: token,
    database,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });
  tokenIssuedAt = Date.now();
  return pool;
};

export const getPool = async (): Promise<Pool> => {
  if (pool && !isExpired()) return pool;
  if (refreshing) return refreshing;
  refreshing = doRefresh().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
};
