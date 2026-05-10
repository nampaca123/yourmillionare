// PostgreSQL BankConnectionRepository: upserts tenant_bank_connections with RLS context.

import type { PoolClient } from 'pg';
import type {
  BankConnection,
  BankConnectionRepository,
} from '../../../application/ports/bank-connection.repository.port.js';
import { withRlsContext } from './pg-rls.context.js';

interface BankConnectionRow {
  id: string;
  tenant_id: string;
  organization: string;
  connected_id: string;
}

const toModel = (row: BankConnectionRow): BankConnection => ({
  id: row.id,
  tenantId: row.tenant_id,
  organization: row.organization,
  connectedId: row.connected_id,
});

export class PgBankConnectionRepository implements BankConnectionRepository {
  async upsert(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    organization: string;
    connectedId: string;
  }): Promise<BankConnection> {
    return withRlsContext(
      { userId: params.userId, cognitoSub: params.cognitoSub, tenantId: params.tenantId },
      async (c: PoolClient) => {
        const result = await c.query<BankConnectionRow>(
          `INSERT INTO tenant_bank_connections (tenant_id, organization, connected_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, organization)
           DO UPDATE SET connected_id = EXCLUDED.connected_id, updated_at = now()
           RETURNING id, tenant_id, organization, connected_id`,
          [params.tenantId, params.organization, params.connectedId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('BankConnection upsert returned no row');
        return toModel(row);
      },
    );
  }

  async findByOrganization(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    organization: string;
  }): Promise<BankConnection | null> {
    return withRlsContext(
      { userId: params.userId, cognitoSub: params.cognitoSub, tenantId: params.tenantId },
      async (c: PoolClient) => {
        const result = await c.query<BankConnectionRow>(
          `SELECT id, tenant_id, organization, connected_id
           FROM tenant_bank_connections
           WHERE tenant_id = $1 AND organization = $2
           LIMIT 1`,
          [params.tenantId, params.organization],
        );
        const row = result.rows[0];
        return row ? toModel(row) : null;
      },
    );
  }
}
