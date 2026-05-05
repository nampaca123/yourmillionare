// PostgreSQL TenantMemberRepository: INSERT under self-insert RLS policy.

import type { PoolClient } from 'pg';
import { createTenantMember } from '../../../domain/tenant-member.entity.js';
import type { TenantMember, TenantRole } from '../../../domain/tenant-member.entity.js';
import type { TenantMemberRepository } from '../../../application/ports/tenant-member.repository.port.js';
import { withRlsContext } from './pg-rls.context.js';

interface TenantMemberRow {
  tenant_id: string;
  user_id: string;
  role: TenantRole;
  joined_at: Date;
}

export class PgTenantMemberRepository implements TenantMemberRepository {
  async add(params: { tenantId: string; userId: string; role: TenantRole }): Promise<TenantMember> {
    return withRlsContext({ userId: params.userId }, async (c: PoolClient) => {
      const result = await c.query<TenantMemberRow>(
        `INSERT INTO tenant_members (tenant_id, user_id, role)
         VALUES ($1, $2, $3)
         RETURNING tenant_id, user_id, role, joined_at`,
        [params.tenantId, params.userId, params.role],
      );
      const row = result.rows[0];
      if (!row) throw new Error('TenantMember insert returned no row');
      return createTenantMember({
        tenantId: row.tenant_id,
        userId: row.user_id,
        role: row.role,
        joinedAt: row.joined_at,
      });
    });
  }
}
