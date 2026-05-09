// Lambda entry point: returns distinct tenant IDs that have active bank accounts.

import { withRlsContext } from '../../outbound/pg/pg-rls.context.js';
import { logger } from '../../../shared/logging/logger.js';

interface TenantsListResult {
  tenantIds: string[];
}

export const handler = async (): Promise<TenantsListResult> => {
  const log = logger.child({ fn: 'tenants-list' });

  const tenantIds = await withRlsContext({ cognitoSub: 'system' }, async (client) => {
    const result = await client.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id
       FROM tenant_bank_accounts
       WHERE is_active = TRUE
       ORDER BY tenant_id`,
    );
    return result.rows.map((r) => r.tenant_id);
  });

  log.info({ count: tenantIds.length }, 'Tenants with active bank accounts listed');
  return { tenantIds };
};
