// PostgreSQL BankAccountRepository: inserts tenant_bank_accounts with RLS context.

import type { PoolClient } from 'pg';
import type { BankAccount, BankAccountRepository } from '../../../application/ports/bank-account.repository.port.js';
import { ConflictError } from '../../../shared/errors/app-error.js';
import { withRlsContext } from './pg-rls.context.js';

const UNIQUE_VIOLATION = '23505';

interface BankAccountRow {
  id: string;
  tenant_id: string;
  organization: string;
  account_number: string;
  is_active: boolean;
  created_at: Date;
}

const toModel = (row: BankAccountRow): BankAccount => ({
  id: row.id,
  tenantId: row.tenant_id,
  organization: row.organization,
  accountNumber: row.account_number,
  isActive: row.is_active,
  createdAt: row.created_at,
});

export class PgBankAccountRepository implements BankAccountRepository {
  async insert(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    organization: string;
    accountNumber: string;
  }): Promise<BankAccount> {
    return withRlsContext(
      { userId: params.userId, cognitoSub: params.cognitoSub, tenantId: params.tenantId },
      async (c: PoolClient) => {
        try {
          const result = await c.query<BankAccountRow>(
            `INSERT INTO tenant_bank_accounts (tenant_id, organization, account_number)
             VALUES ($1, $2, $3)
             RETURNING id, tenant_id, organization, account_number, is_active, created_at`,
            [params.tenantId, params.organization, params.accountNumber],
          );
          const row = result.rows[0];
          if (!row) throw new Error('BankAccount insert returned no row');
          return toModel(row);
        } catch (err: unknown) {
          const pg = err as { code?: string };
          if (pg.code === UNIQUE_VIOLATION) {
            throw new ConflictError('A bank account with this organization and account number already exists for this tenant.');
          }
          throw err;
        }
      },
    );
  }
}
