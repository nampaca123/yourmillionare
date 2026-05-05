// PostgreSQL TenantRepository: stateless — userId passed per operation for RLS context.

import type { PoolClient } from 'pg';
import type { Tenant } from '../../../domain/tenant.entity.js';
import { createTenant } from '../../../domain/tenant.entity.js';
import type { TenantRepository, CreateTenantParams } from '../../../application/ports/tenant.repository.port.js';
import { ConflictError } from '../../../shared/errors/app-error.js';
import type { BizRegNo } from '../../../domain/biz-reg-no.value-object.js';
import { withRlsContext } from './pg-rls.context.js';

interface TenantRow {
  id: string;
  legal_name: string;
  display_name: string;
  created_at: Date;
}

const UNIQUE_VIOLATION = '23505';

const toTenant = (row: TenantRow): Tenant =>
  createTenant({
    id: row.id,
    bizRegNo: '' as BizRegNo,
    legalName: row.legal_name,
    displayName: row.display_name,
    foundedOn: undefined,
    regionCode: undefined,
    createdAt: row.created_at,
  });

export class PgTenantRepository implements TenantRepository {
  async create(params: CreateTenantParams): Promise<Tenant> {
    return withRlsContext({ userId: params.userId }, async (c: PoolClient) => {
      try {
        const result = await c.query<TenantRow>(
          `INSERT INTO tenants (biz_reg_no_encrypted, biz_reg_no_hash, legal_name, display_name)
           VALUES ($1, $2, $3, $4)
           RETURNING id, legal_name, display_name, created_at`,
          [params.bizRegNoEncrypted, params.bizRegNoHash, params.legalName, params.displayName],
        );
        const row = result.rows[0];
        if (!row) throw new Error('Tenant insert returned no row');
        return toTenant(row);
      } catch (err: unknown) {
        const pg = err as { code?: string };
        if (pg.code === UNIQUE_VIOLATION) throw new ConflictError('A tenant with this business registration number already exists');
        throw err;
      }
    });
  }

  async findAllByUserId(userId: string): Promise<Tenant[]> {
    return withRlsContext({ userId }, async (c: PoolClient) => {
      const result = await c.query<TenantRow>(
        `SELECT id, legal_name, display_name, created_at FROM tenants ORDER BY created_at ASC`,
      );
      return result.rows.map(toTenant);
    });
  }
}
