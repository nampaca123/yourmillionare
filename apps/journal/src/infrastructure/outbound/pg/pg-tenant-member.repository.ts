// PostgreSQL TenantMemberRepository: checks tenant membership via RLS with user-only context.

import type { PoolClient } from 'pg';
import type { TenantMemberRepository } from '../../../application/ports/tenant-member.repository.port.js';
import { withRlsContext } from './pg-rls.context.js';

export class PgTenantMemberRepository implements TenantMemberRepository {
  async isMember(params: { tenantId: string; userId: string; cognitoSub: string }): Promise<boolean> {
    const { tenantId, userId, cognitoSub } = params;
    return withRlsContext({ userId, tenantId, cognitoSub }, async (c: PoolClient) => {
      const result = await c.query(
        'SELECT 1 FROM tenant_members WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, userId],
      );
      return result.rows.length > 0;
    });
  }
}
