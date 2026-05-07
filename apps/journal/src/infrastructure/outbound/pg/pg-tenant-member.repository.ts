// PostgreSQL TenantMemberRepository: checks tenant membership via RLS with user-only context.

import type { PoolClient } from 'pg';
import type { TenantMemberRepository } from '../../../application/ports/tenant-member.repository.port.js';
import { withRlsContext } from './pg-rls.context.js';

export class PgTenantMemberRepository implements TenantMemberRepository {
  async isMember(tenantId: string, userId: string): Promise<boolean> {
    return withRlsContext({ userId }, async (c: PoolClient) => {
      const result = await c.query(
        'SELECT 1 FROM tenant_members WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, userId],
      );
      return result.rows.length > 0;
    });
  }
}
