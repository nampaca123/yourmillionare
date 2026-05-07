// Sets PostgreSQL GUC variables within a transaction scope for RLS enforcement.

import type { PoolClient } from 'pg';
import { getPool } from './pg-pool.client.js';

export interface RlsContext {
  // Set first — required for SELECT on users (chicken-and-egg resolved by 0001 migration).
  cognitoSub?: string;
  // Set once user row is found/created.
  userId?: string;
  // Set for tenant-scoped operations.
  tenantId?: string;
}

export const withRlsContext = async <T>(
  ctx: RlsContext,
  work: (c: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await (await getPool()).connect();
  try {
    await client.query('BEGIN');
    await client.query('RESET app.cognito_sub');
    await client.query('RESET app.current_user_id');
    await client.query('RESET app.current_tenant_id');

    if (ctx.cognitoSub) {
      await client.query("SELECT set_config('app.cognito_sub', $1, true)", [ctx.cognitoSub]);
    }
    if (ctx.userId) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [ctx.userId]);
    }
    if (ctx.tenantId) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [ctx.tenantId]);
    }

    const result = await work(client);

    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};
