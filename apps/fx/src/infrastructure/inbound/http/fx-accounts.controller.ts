// Controllers: FX account CRUD over tenant_bank_accounts (manual USD MVP + CODEF discover/link via stored connectedId).

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '@ym/shared-errors';
import { withRlsContext } from '../../outbound/pg/pg-rls.context.js';
import { getCodefFxToken } from '../../outbound/codef/codef-auth.client.js';
import { listForeignAccounts, type DiscoveredFxAccount } from '../../outbound/codef/codef-account.client.js';
import { parseClaims } from './auth-claims.mapper.js';
import {
  DiscoverFxAccountsQuerySchema,
  LinkFxAccountBodySchema,
  RegisterFxAccountBodySchema,
  UpdateFxBalanceBodySchema,
} from './fx-accounts.schema.js';

const MANUAL_ORG = 'MANL';
const MANUAL_ACCOUNT_PREFIX = 'MANUAL-';
const MANUAL_ID_SUFFIX_BYTES = 4;
const SUPPORTED_FX_CURRENCY = 'USD';

interface ForeignAccountRow {
  id: string;
  organization: string;
  account_number: string;
  is_manual: boolean;
  currency: string;
  bank_label: string | null;
  manual_balance_fcy: string | null;
  manual_balance_synced_at: Date | null;
  last_balance_krw: string | null;
  balance_synced_at: Date | null;
}

interface ApiAccount {
  accountId: string;
  source: 'manual' | 'codef';
  organization: string;
  accountNumber: string;
  currency: string;
  bankLabel: string | null;
  balanceFcy: number | null;
  balanceKrwToday: number | null;
  lastSyncedAt: string | null;
}

const parseBody = (raw: string | null | undefined): unknown => {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('Request body is not valid JSON');
  }
};

const generateManualAccountNumber = (): string => {
  const bytes = new Uint8Array(MANUAL_ID_SUFFIX_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${MANUAL_ACCOUNT_PREFIX}${hex}`;
};

const fetchLatestUsdKrwRate = async (
  client: import('pg').PoolClient,
): Promise<number | null> => {
  const result = await client.query<{ rate: string }>(
    `SELECT rate::text
       FROM fx_observations
      WHERE quote_currency = 'USD' AND rate_type = 'closing'
   ORDER BY observed_on DESC
      LIMIT 1`,
  );
  const row = result.rows[0];
  return row ? Number.parseFloat(row.rate) : null;
};

const toApiAccount = (row: ForeignAccountRow, latestUsdKrw: number | null): ApiAccount => {
  const source: 'manual' | 'codef' = row.is_manual ? 'manual' : 'codef';
  const balanceFcy = row.manual_balance_fcy !== null ? Number.parseFloat(row.manual_balance_fcy) : null;
  const balanceKrwFromManual =
    balanceFcy !== null && latestUsdKrw !== null && row.currency === 'USD' ? balanceFcy * latestUsdKrw : null;
  const balanceKrwFromCodef = row.last_balance_krw !== null ? Number.parseFloat(row.last_balance_krw) : null;
  const lastSyncedAt = row.manual_balance_synced_at ?? row.balance_synced_at;
  return {
    accountId: row.id,
    source,
    organization: row.organization,
    accountNumber: row.account_number,
    currency: row.currency,
    bankLabel: row.bank_label,
    balanceFcy,
    balanceKrwToday: source === 'manual' ? balanceKrwFromManual : balanceKrwFromCodef,
    lastSyncedAt: lastSyncedAt ? lastSyncedAt.toISOString() : null,
  };
};

export const registerFxAccountController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';
  const parsed = RegisterFxAccountBodySchema.safeParse(parseBody(event.body));
  if (!parsed.success) throw new ZodError(parsed.error.issues);

  const accountNumber = generateManualAccountNumber();
  const { currency, balance, bankLabel } = parsed.data;

  const account = await withRlsContext({ tenantId, cognitoSub: claims.cognitoSub }, async (client) => {
    const result = await client.query<ForeignAccountRow>(
      `INSERT INTO tenant_bank_accounts (
         tenant_id, organization, account_number, account_kind, currency,
         is_manual, manual_balance_fcy, manual_balance_synced_at, bank_label
       )
       VALUES ($1, $2, $3, 'foreign', $4, TRUE, $5, now(), $6)
       RETURNING id, organization, account_number, is_manual, currency, bank_label,
                 manual_balance_fcy::text, manual_balance_synced_at,
                 last_balance_krw::text, balance_synced_at`,
      [tenantId, MANUAL_ORG, accountNumber, currency, balance, bankLabel ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new ConflictError('Failed to register manual FX account');
    const latest = await fetchLatestUsdKrwRate(client);
    return toApiAccount(row, latest);
  });

  return { statusCode: 201, body: JSON.stringify(account) };
};

export const listFxAccountsController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';

  const accounts = await withRlsContext({ tenantId, cognitoSub: claims.cognitoSub }, async (client) => {
    const result = await client.query<ForeignAccountRow>(
      `SELECT id, organization, account_number, is_manual, currency, bank_label,
              manual_balance_fcy::text, manual_balance_synced_at,
              last_balance_krw::text, balance_synced_at
         FROM tenant_bank_accounts
        WHERE tenant_id = $1
          AND account_kind = 'foreign'
          AND is_active = TRUE
     ORDER BY created_at DESC`,
      [tenantId],
    );
    const latest = await fetchLatestUsdKrwRate(client);
    return result.rows.map((row) => toApiAccount(row, latest));
  });

  return { statusCode: 200, body: JSON.stringify({ accounts }) };
};

export const updateFxAccountBalanceController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';
  const accountId = event.pathParameters?.accountId ?? '';
  const parsed = UpdateFxBalanceBodySchema.safeParse(parseBody(event.body));
  if (!parsed.success) throw new ZodError(parsed.error.issues);

  const account = await withRlsContext({ tenantId, cognitoSub: claims.cognitoSub }, async (client) => {
    const existing = await client.query<{ is_manual: boolean; is_active: boolean }>(
      `SELECT is_manual, is_active
         FROM tenant_bank_accounts
        WHERE id = $1 AND tenant_id = $2 AND account_kind = 'foreign'`,
      [accountId, tenantId],
    );
    const existingRow = existing.rows[0];
    if (!existingRow || !existingRow.is_active) throw new NotFoundError('FX account');
    if (!existingRow.is_manual) throw new ConflictError('CODEF-synced accounts cannot be edited manually');

    const result = await client.query<ForeignAccountRow>(
      `UPDATE tenant_bank_accounts
          SET manual_balance_fcy = $1,
              manual_balance_synced_at = now()
        WHERE id = $2 AND tenant_id = $3 AND is_manual = TRUE
    RETURNING id, organization, account_number, is_manual, currency, bank_label,
              manual_balance_fcy::text, manual_balance_synced_at,
              last_balance_krw::text, balance_synced_at`,
      [parsed.data.balance, accountId, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('FX account');
    const latest = await fetchLatestUsdKrwRate(client);
    return toApiAccount(row, latest);
  });

  return { statusCode: 200, body: JSON.stringify(account) };
};

interface DiscoverableAccount {
  accountNumber: string;
  accountDisplay: string;
  accountName: string;
  currency: string;
  balanceFcy: number;
  supported: boolean;
  alreadyLinked: boolean;
}

const fetchConnectedId = async (
  client: import('pg').PoolClient,
  tenantId: string,
  organization: string,
): Promise<string | null> => {
  const result = await client.query<{ connected_id: string }>(
    `SELECT connected_id
       FROM tenant_bank_connections
      WHERE tenant_id = $1 AND organization = $2`,
    [tenantId, organization],
  );
  return result.rows[0]?.connected_id ?? null;
};

const fetchLinkedAccountNumbers = async (
  client: import('pg').PoolClient,
  tenantId: string,
  organization: string,
): Promise<Set<string>> => {
  const result = await client.query<{ account_number: string }>(
    `SELECT account_number
       FROM tenant_bank_accounts
      WHERE tenant_id = $1
        AND organization = $2
        AND account_kind = 'foreign'
        AND is_active = TRUE`,
    [tenantId, organization],
  );
  return new Set(result.rows.map((row) => row.account_number));
};

const toDiscoverableAccount = (
  account: DiscoveredFxAccount,
  linked: Set<string>,
): DiscoverableAccount => ({
  accountNumber: account.accountNumber,
  accountDisplay: account.accountDisplay,
  accountName: account.accountName,
  currency: account.currency,
  balanceFcy: Number.parseFloat(account.balanceFcy),
  supported: account.currency === SUPPORTED_FX_CURRENCY,
  alreadyLinked: linked.has(account.accountNumber),
});

export const discoverFxAccountsController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';
  const parsedQuery = DiscoverFxAccountsQuerySchema.safeParse(event.queryStringParameters ?? {});
  if (!parsedQuery.success) throw new ZodError(parsedQuery.error.issues);
  const { organization } = parsedQuery.data;

  const { connectedId, linkedNumbers } = await withRlsContext(
    { tenantId, cognitoSub: claims.cognitoSub },
    async (client) => {
      const id = await fetchConnectedId(client, tenantId, organization);
      const linked = await fetchLinkedAccountNumbers(client, tenantId, organization);
      return { connectedId: id, linkedNumbers: linked };
    },
  );

  if (!connectedId) {
    throw new NotFoundError(
      `No CODEF bank connection for organization ${organization}. Connect via /tenants/{tenantId}/bank-connections first.`,
    );
  }

  const token = await getCodefFxToken();
  const discovered = await listForeignAccounts(token, connectedId, organization);
  const accounts = discovered.map((account) => toDiscoverableAccount(account, linkedNumbers));

  return { statusCode: 200, body: JSON.stringify({ accounts }) };
};

export const linkFxAccountController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';
  const parsed = LinkFxAccountBodySchema.safeParse(parseBody(event.body));
  if (!parsed.success) throw new ZodError(parsed.error.issues);
  const { organization, accountNumber, bankLabel } = parsed.data;

  const connectedId = await withRlsContext(
    { tenantId, cognitoSub: claims.cognitoSub },
    async (client) => fetchConnectedId(client, tenantId, organization),
  );
  if (!connectedId) {
    throw new NotFoundError(
      `No CODEF bank connection for organization ${organization}. Connect via /tenants/{tenantId}/bank-connections first.`,
    );
  }

  const token = await getCodefFxToken();
  const discovered = await listForeignAccounts(token, connectedId, organization);
  const match = discovered.find((account) => account.accountNumber === accountNumber);
  if (!match) {
    throw new NotFoundError(`FX account ${accountNumber} not found on CODEF for organization ${organization}`);
  }
  if (match.currency !== SUPPORTED_FX_CURRENCY) {
    throw new ValidationError(`Only ${SUPPORTED_FX_CURRENCY} accounts are supported in MVP (got ${match.currency})`);
  }

  const balanceFcy = Number.parseFloat(match.balanceFcy);
  if (!Number.isFinite(balanceFcy) || balanceFcy < 0) {
    throw new ValidationError('CODEF returned an invalid balance for this account');
  }

  const account = await withRlsContext({ tenantId, cognitoSub: claims.cognitoSub }, async (client) => {
    const latestUsdKrw = await fetchLatestUsdKrwRate(client);
    const balanceKrw = latestUsdKrw !== null ? balanceFcy * latestUsdKrw : null;

    const result = await client.query<ForeignAccountRow>(
      `INSERT INTO tenant_bank_accounts (
         tenant_id, organization, account_number, account_kind, currency,
         is_manual, connected_id, bank_label,
         last_balance_krw, balance_synced_at
       )
       VALUES ($1, $2, $3, 'foreign', $4, FALSE, $5, $6, $7, now())
       RETURNING id, organization, account_number, is_manual, currency, bank_label,
                 manual_balance_fcy::text, manual_balance_synced_at,
                 last_balance_krw::text, balance_synced_at`,
      [tenantId, organization, match.accountNumber, match.currency, connectedId, bankLabel ?? null, balanceKrw],
    );
    const row = result.rows[0];
    if (!row) throw new ConflictError('FX account already linked for this organization and account number');
    return toApiAccount(row, latestUsdKrw);
  }).catch((err: unknown) => {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
      throw new ConflictError('FX account already linked for this organization and account number');
    }
    throw err;
  });

  return { statusCode: 201, body: JSON.stringify(account) };
};

export const deactivateFxAccountController = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = parseClaims(event.requestContext.authorizer.jwt.claims);
  const tenantId = event.pathParameters?.tenantId ?? '';
  const accountId = event.pathParameters?.accountId ?? '';

  await withRlsContext({ tenantId, cognitoSub: claims.cognitoSub }, async (client) => {
    const existing = await client.query<{ is_active: boolean }>(
      `SELECT is_active
         FROM tenant_bank_accounts
        WHERE id = $1 AND tenant_id = $2 AND account_kind = 'foreign'`,
      [accountId, tenantId],
    );
    const existingRow = existing.rows[0];
    if (!existingRow) throw new NotFoundError('FX account');
    if (!existingRow.is_active) return;

    await client.query(
      `UPDATE tenant_bank_accounts
          SET is_active = FALSE
        WHERE id = $1 AND tenant_id = $2 AND account_kind = 'foreign'`,
      [accountId, tenantId],
    );
  });

  return { statusCode: 204, body: '' };
};
