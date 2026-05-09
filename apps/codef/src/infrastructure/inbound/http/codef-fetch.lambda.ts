// Lambda entry point: fetches CODEF bank transactions per tenant and queues them for classification.

import { withRlsContext } from '../../outbound/pg/pg-rls.context.js';
import { getCodefSecret } from '../../outbound/codef/codef-auth.client.js';
import { fetchTransactions } from '../../outbound/codef/codef-bank.client.js';
import { upsertBatch, markDispatched, findLatestFetchedAt } from '../../outbound/pg/pg-raw-transaction.repository.js';
import { sendTaskBatch } from '../../outbound/sqs/classify-dispatcher.client.js';
import { logger } from '../../../shared/logging/logger.js';

const DEFAULT_LOOKBACK_DAYS = 2;
const SOURCE = 'codef_bank';

interface FetchPayload {
  tenantId: string;
}

interface FetchResult {
  tenantId: string;
  fetched: number;
  queued: number;
}

interface BankAccountRow {
  organization: string;
  account_number: string;
}

const toDateStr = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
};

export const handler = async (event: FetchPayload): Promise<FetchResult> => {
  const { tenantId } = event;
  const log = logger.child({ fn: 'codef-fetch', tenantId });

  const [codefSecret, accounts] = await Promise.all([
    getCodefSecret(),
    withRlsContext({ cognitoSub: 'system', tenantId }, async (client) => {
      const result = await client.query<BankAccountRow>(
        `SELECT organization, account_number
         FROM tenant_bank_accounts
         WHERE tenant_id = $1 AND is_active = TRUE`,
        [tenantId],
      );
      return result.rows;
    }),
  ]);

  if (accounts.length === 0) {
    log.info('No active bank accounts for tenant');
    return { tenantId, fetched: 0, queued: 0 };
  }

  const connectedId = codefSecret.connectedIds[tenantId];
  if (!connectedId) {
    log.error({ tenantId }, 'connectedId not found in CODEF secret for tenant');
    throw new Error(`connectedId missing for tenant ${tenantId}`);
  }

  const endDate = toDateStr(new Date());
  let totalFetched = 0;
  const allNewIds: string[] = [];

  for (const account of accounts) {
    const latestFetchedAt = await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
      findLatestFetchedAt(client, tenantId, SOURCE),
    );

    const startDateObj = latestFetchedAt
      ? new Date(latestFetchedAt.getTime() - 24 * 60 * 60 * 1000)
      : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const startDate = toDateStr(startDateObj);

    log.info({ organization: account.organization, startDate, endDate }, 'Fetching CODEF transactions');

    const transactions = await fetchTransactions({
      connectedId,
      organization: account.organization,
      accountNumber: account.account_number,
      startDate,
      endDate,
    });

    totalFetched += transactions.length;

    if (transactions.length === 0) continue;

    const newIds = await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
      upsertBatch(client, tenantId, SOURCE, transactions),
    );

    allNewIds.push(...newIds);
  }

  if (allNewIds.length > 0) {
    await sendTaskBatch(allNewIds.map((id) => ({ rawTransactionId: id, tenantId })));

    await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
      markDispatched(client, allNewIds),
    );
  }

  log.info({ fetched: totalFetched, queued: allNewIds.length }, 'Codef fetch complete');
  return { tenantId, fetched: totalFetched, queued: allNewIds.length };
};
