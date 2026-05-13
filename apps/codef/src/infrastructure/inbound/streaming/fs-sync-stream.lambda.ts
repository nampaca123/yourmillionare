// Function URL Lambda: SSE-streams the end-to-end /fs/sync flow (sync_run → fetch → classify → certain/uncertain events).

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  closeSseStream,
  withStreamingErrorBoundary,
  type SseSink,
  type StreamingFunctionUrlEvent,
  type StreamingResponseStream,
} from '@ym/agent-core';
import { verifyJwt } from '@ym/shared-auth';
import {
  BedrockConverseClassifier,
  DeterministicStubClassifier,
  DdbCacheProjectorAdapter,
  K_IFRS_DEFAULT_ACCOUNTS,
  PgJournalRepository,
  createJournalEntry,
  type TransactionClassifier,
} from '@ym/journal-core';
import { AppError, ForbiddenError, ValidationError, toHttpErrorResponse } from '@ym/shared-errors';
import { withRlsContext } from '../../outbound/pg/pg-rls.context.js';
import { fetchTransactions } from '../../outbound/codef/codef-bank.client.js';
import { upsertBatch, markDispatched } from '../../outbound/pg/pg-raw-transaction.repository.js';
import {
  completeSyncRun,
  createSyncRun,
  failSyncRun,
  markSyncRunRunning,
  recordAccountOutcome,
  type SyncRunAccountOutcome,
} from '../../outbound/pg/pg-sync-run.repository.js';
import {
  mapCodefErrorToUserMessage,
  NO_CONNECTION_USER_MESSAGE,
} from '../../../application/codef-error-messages.js';
import { logger } from '../../../shared/logging/logger.js';

const DRAFT_CONFIDENCE_THRESHOLD = Number.parseFloat(process.env.DRAFT_CONFIDENCE_THRESHOLD ?? '0.5');
const DEFAULT_LOOKBACK_DAYS = 2;
const INITIAL_LOOKBACK_DAYS = 31;
const MS_PER_DAY = 86_400_000;
const MAX_RANGE_DAYS = 366;
const SOURCE = 'codef_bank';
const SYSTEM_USER_UUID = process.env.SYSTEM_USER_UUID ?? '00000000-0000-0000-0000-000000000001';
const HEARTBEAT_INTERVAL_MS = 10_000;
const MASK_TAIL_VISIBLE = 4;

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const PATH_RE = /^\/tenants\/([0-9a-f-]+)\/fs\/sync\/?$/i;

const RequestBodySchema = z
  .object({
    from: z.string().regex(ISO_DATE).optional(),
    to: z.string().regex(ISO_DATE).optional(),
    accountIds: z.array(z.string().regex(UUID)).max(20).optional(),
  })
  .strict();

type ResponseStream = StreamingResponseStream;
type FunctionUrlEvent = StreamingFunctionUrlEvent;

interface BankAccountRow {
  id: string;
  organization: string;
  account_number: string;
  connected_id: string | null;
  last_balance_krw: string | null;
}

interface RawTxRow {
  id: string;
  occurred_at: Date;
  amount: string;
  counterparty: string | null;
  bank_account_id: string | null;
  source_organization: string | null;
  source_account_number: string | null;
}

const writeEvent = (stream: SseSink, payload: Record<string, unknown>): void => {
  stream.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const classifier: TransactionClassifier =
  process.env.CLASSIFY_MODE === 'stub'
    ? new DeterministicStubClassifier()
    : new BedrockConverseClassifier();
const journalRepo = new PgJournalRepository();
const cacheProjector = new DdbCacheProjectorAdapter();

const decodeBody = (event: FunctionUrlEvent): string => {
  if (!event.body) return '';
  if (event.isBase64Encoded) return Buffer.from(event.body, 'base64').toString('utf-8');
  return event.body;
};

const toCompactDate = (iso: string): string => iso.replace(/-/g, '');
const fromDateObj = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
};

const maskAccountNumber = (raw: string | null): string | null => {
  if (!raw) return null;
  if (raw.length <= MASK_TAIL_VISIBLE) return raw;
  const tail = raw.slice(-MASK_TAIL_VISIBLE);
  return `${'*'.repeat(raw.length - MASK_TAIL_VISIBLE)}${tail}`;
};

const validateDateRange = (from: string | undefined, to: string | undefined): void => {
  if (!from && !to) return;
  if (!from || !to) throw new ValidationError('Both "from" and "to" must be provided together');
  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  if (fromTime > toTime) throw new ValidationError('"from" must be on or before "to"');
  const todayMidnight = Date.parse(new Date().toISOString().slice(0, 10));
  if (toTime > todayMidnight) throw new ValidationError('"to" cannot be in the future');
  const span = Math.round((toTime - fromTime) / MS_PER_DAY);
  if (span > MAX_RANGE_DAYS) throw new ValidationError(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
};

const resolveUserId = async (cognitoSub: string, email: string): Promise<string> => {
  return withRlsContext({ cognitoSub }, async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE cognito_sub = $1`,
      [cognitoSub],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, email) VALUES ($1, $2) RETURNING id`,
      [cognitoSub, email],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.', 'Failed to insert user');
    return id;
  });
};

const verifyMembership = async (tenantId: string, userId: string, cognitoSub: string): Promise<void> => {
  const isMember = await withRlsContext({ userId, tenantId, cognitoSub }, async (client) => {
    const result = await client.query(
      `SELECT 1 FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    return result.rows.length > 0;
  });
  if (!isMember) throw new ForbiddenError(`User ${cognitoSub} is not a member of tenant ${tenantId}`);
};

const loadAccounts = async (
  tenantId: string,
  accountIds: ReadonlyArray<string> | undefined,
): Promise<BankAccountRow[]> =>
  withRlsContext({ cognitoSub: 'system', tenantId }, async (client) => {
    if (accountIds && accountIds.length > 0) {
      const result = await client.query<BankAccountRow>(
        `SELECT id, organization, account_number, connected_id, last_balance_krw::text
           FROM tenant_bank_accounts
          WHERE tenant_id = $1 AND is_active = TRUE AND id = ANY($2::uuid[])`,
        [tenantId, accountIds],
      );
      return result.rows;
    }
    const result = await client.query<BankAccountRow>(
      `SELECT id, organization, account_number, connected_id, last_balance_krw::text
         FROM tenant_bank_accounts
        WHERE tenant_id = $1 AND is_active = TRUE`,
      [tenantId],
    );
    return result.rows;
  });

const updateAccountBalance = async (
  tenantId: string,
  account: BankAccountRow,
  balance: { currentBalanceKrw: number; withdrawableKrw: number | null; syncedAt: Date },
): Promise<void> => {
  await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
    client.query(
      `UPDATE tenant_bank_accounts
          SET last_balance_krw      = $1,
              last_withdrawable_krw = $2,
              balance_synced_at     = $3
        WHERE tenant_id = $4 AND organization = $5 AND account_number = $6`,
      [
        balance.currentBalanceKrw,
        balance.withdrawableKrw,
        balance.syncedAt,
        tenantId,
        account.organization,
        account.account_number,
      ],
    ),
  );
};

interface AccountResult {
  bankAccountId: string;
  organization: string;
  accountNumber: string;
  outcome: SyncRunAccountOutcome;
  codefErrorCode: string | null;
  codefErrorMessage: string | null;
  userMessage: string | null;
  fetchedCount: number;
  balanceUpdated: boolean;
  previousBalance: number | null;
  currentBalance: number | null;
  newRawTxIds: string[];
}

const processAccount = async (
  tenantId: string,
  account: BankAccountRow,
  syncRunId: string,
  startDate: string,
  endDate: string,
): Promise<AccountResult> => {
  const previousBalance =
    account.last_balance_krw !== null ? Number.parseFloat(account.last_balance_krw) : null;
  const base: AccountResult = {
    bankAccountId: account.id,
    organization: account.organization,
    accountNumber: account.account_number,
    outcome: 'success',
    codefErrorCode: null,
    codefErrorMessage: null,
    userMessage: null,
    fetchedCount: 0,
    balanceUpdated: false,
    previousBalance,
    currentBalance: null,
    newRawTxIds: [],
  };

  if (!account.connected_id) {
    return { ...base, outcome: 'no_connection', userMessage: NO_CONNECTION_USER_MESSAGE };
  }

  const codefRes = await fetchTransactions({
    connectedId: account.connected_id,
    organization: account.organization,
    accountNumber: account.account_number,
    startDate,
    endDate,
  });

  if (!codefRes.ok) {
    return {
      ...base,
      outcome: 'codef_error',
      codefErrorCode: codefRes.code,
      codefErrorMessage: codefRes.message,
      userMessage: mapCodefErrorToUserMessage(account.organization, codefRes.code, codefRes.message),
    };
  }

  let balanceUpdated = false;
  let currentBalance: number | null = null;
  if (codefRes.data.balance) {
    await updateAccountBalance(tenantId, account, codefRes.data.balance);
    balanceUpdated = true;
    currentBalance = codefRes.data.balance.currentBalanceKrw;
  }

  if (codefRes.data.transactions.length === 0) {
    return {
      ...base,
      outcome: balanceUpdated ? 'balance_only' : 'empty_result',
      balanceUpdated,
      currentBalance,
    };
  }

  const newIds = await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
    upsertBatch({
      client,
      tenantId,
      source: SOURCE,
      bankAccountId: account.id,
      syncRunId,
      txs: codefRes.data.transactions,
    }),
  );

  return {
    ...base,
    outcome: 'success',
    balanceUpdated,
    currentBalance,
    fetchedCount: codefRes.data.transactions.length,
    newRawTxIds: newIds,
  };
};

interface ClassifyOutcome {
  rawTransactionId: string;
  occurredAt: Date;
  amount: number;
  counterparty: string | null;
  sourceAccount: { bankAccountId: string | null; organization: string | null; accountNumberMasked: string | null };
  status: 'certain' | 'uncertain';
  origin: 'heuristic' | 'ai' | 'ai_low_conf';
  confidence: number;
  ruleId: string;
  lines: ReadonlyArray<{ lineNo: number; accountCode: string; debit: number; credit: number; memo: string | null }>;
  journalEntryId: string | null;
}

const fetchRawTransaction = async (
  tenantId: string,
  rawTransactionId: string,
): Promise<RawTxRow | undefined> =>
  withRlsContext({ cognitoSub: 'system', tenantId }, async (client) => {
    const result = await client.query<RawTxRow>(
      `SELECT rt.id, rt.occurred_at, rt.amount::text, rt.counterparty, rt.bank_account_id,
              tba.organization   AS source_organization,
              tba.account_number AS source_account_number
         FROM raw_transactions rt
         LEFT JOIN tenant_bank_accounts tba ON tba.id = rt.bank_account_id
        WHERE rt.id = $1 AND rt.tenant_id = $2`,
      [rawTransactionId, tenantId],
    );
    return result.rows[0];
  });

const seedAccountsIfMissing = async (
  client: import('pg').PoolClient,
  tenantId: string,
): Promise<void> => {
  const seedValues = K_IFRS_DEFAULT_ACCOUNTS.map((_, i) => {
    const b = i * 6;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
  }).join(', ');
  const seedParams = K_IFRS_DEFAULT_ACCOUNTS.flatMap((a) => [
    tenantId,
    a.code,
    a.name,
    a.displayName,
    a.type,
    a.normalBalance,
  ]);
  await client.query(
    `INSERT INTO accounts (tenant_id, code, name, display_name, type, normal_balance)
     VALUES ${seedValues}
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    seedParams,
  );
};

const classifyRawTransaction = async (
  tenantId: string,
  syncRunId: string,
  rawTransactionId: string,
): Promise<ClassifyOutcome | null> => {
  const raw = await fetchRawTransaction(tenantId, rawTransactionId);
  if (!raw) return null;

  const entryDate = raw.occurred_at.toISOString().slice(0, 10);
  const counterparty = raw.counterparty ?? 'Unknown';
  const amount = Math.abs(Number.parseFloat(raw.amount));
  const classifyResult = await classifier.classify({
    date: entryDate,
    amount,
    counterparty,
    memo: counterparty,
  });

  const sourceAccount = {
    bankAccountId: raw.bank_account_id,
    organization: raw.source_organization,
    accountNumberMasked: maskAccountNumber(raw.source_account_number),
  };
  const ruleId = `bedrock:${classifyResult.modelId}`;

  const isUncertain = classifyResult.confidence < DRAFT_CONFIDENCE_THRESHOLD;
  const confidenceStatus: 'certain' | 'uncertain' = isUncertain ? 'uncertain' : 'certain';
  const origin: 'ai' | 'ai_low_conf' = isUncertain ? 'ai_low_conf' : 'ai';

  const entry = createJournalEntry({
    tenantId,
    entryDate,
    source: SOURCE,
    sourceRefId: rawTransactionId,
    createdBy: SYSTEM_USER_UUID,
    lines: classifyResult.lines,
    aiConfidence: classifyResult.confidence,
    aiModel: classifyResult.modelId,
    description: counterparty,
    confidenceStatus,
    confidence: classifyResult.confidence,
    origin,
    syncRunId,
    entryStatus: isUncertain ? 'draft' : 'posted',
  });
  const journalEntryId = randomUUID();
  const entryWithId = { ...entry, id: journalEntryId };

  const saved = await withRlsContext({ cognitoSub: 'system', tenantId }, async (client) => {
    await seedAccountsIfMissing(client, tenantId);
    const exists = await journalRepo.existsBySourceRef(client, tenantId, rawTransactionId);
    if (exists) return null;

    const [persisted] = await journalRepo.saveEntriesAtomically(client, [entryWithId]);
    if (!persisted) return null;
    await client.query(
      `INSERT INTO ai_decisions (entry_id, tenant_id, model, input_tokens, output_tokens, confidence)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (entry_id) DO NOTHING`,
      [
        persisted.id,
        tenantId,
        classifyResult.modelId,
        classifyResult.inputTokens ?? null,
        classifyResult.outputTokens ?? null,
        classifyResult.confidence,
      ],
    );
    await markDispatched(client, [rawTransactionId]);
    return persisted;
  });

  if (saved && !isUncertain) {
    try {
      await cacheProjector.projectEntry(tenantId, saved);
    } catch (cacheErr) {
      logger.warn({ err: cacheErr, rawTransactionId }, 'Cache projection failed (non-fatal)');
    }
  }

  return {
    rawTransactionId,
    occurredAt: raw.occurred_at,
    amount,
    counterparty: raw.counterparty,
    sourceAccount,
    status: confidenceStatus,
    origin,
    confidence: classifyResult.confidence,
    ruleId,
    lines: classifyResult.lines.map((l) => ({
      lineNo: l.lineNo,
      accountCode: l.accountCode,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo ?? null,
    })),
    journalEntryId: saved?.id ?? null,
  };
};

const summarize = (results: AccountResult[]): string => {
  const success = results.filter((r) => r.outcome === 'success').length;
  const errors = results.filter((r) => r.outcome === 'codef_error' || r.outcome === 'no_connection').length;
  const empty = results.filter((r) => r.outcome === 'empty_result' || r.outcome === 'balance_only').length;
  const parts: string[] = [];
  if (success > 0) parts.push(`${success}개 계좌 동기화 완료`);
  if (errors > 0) parts.push(`${errors}개 계좌 처리 필요`);
  if (empty > 0) parts.push(`${empty}개 계좌 거래 내역 없음`);
  return parts.length > 0 ? parts.join(', ') : '동기화할 계좌가 없습니다';
};

const resolveDateRange = async (
  tenantId: string,
  from: string | undefined,
  to: string | undefined,
): Promise<{ startDate: string; endDate: string }> => {
  if (from && to) {
    return { startDate: toCompactDate(from), endDate: toCompactDate(to) };
  }
  const latestFetchedAt = await withRlsContext({ cognitoSub: 'system', tenantId }, async (client) => {
    const result = await client.query<{ fetched_at: Date | null }>(
      `SELECT MAX(fetched_at) AS fetched_at FROM raw_transactions WHERE tenant_id = $1 AND source = $2`,
      [tenantId, SOURCE],
    );
    return result.rows[0]?.fetched_at ?? null;
  });
  const startDateObj = latestFetchedAt
    ? new Date(latestFetchedAt.getTime() - DEFAULT_LOOKBACK_DAYS * MS_PER_DAY)
    : new Date(Date.now() - INITIAL_LOOKBACK_DAYS * MS_PER_DAY);
  return { startDate: fromDateObj(startDateObj), endDate: fromDateObj(new Date()) };
};

const extractTenantIdFromPath = (rawPath: string | undefined): string => {
  const match = PATH_RE.exec(rawPath ?? '');
  if (!match || !match[1]) throw new ValidationError('Invalid path; expected /tenants/{tenantId}/fs/sync');
  return match[1];
};

const handlerImpl = async (event: FunctionUrlEvent, responseStream: ResponseStream): Promise<void> => {
  const startedAt = Date.now();
  responseStream.setContentType?.('text/event-stream');

  const heartbeat = setInterval(() => {
    responseStream.write(`data: {"type":"heartbeat","ts":${Date.now()}}\n\n`);
  }, HEARTBEAT_INTERVAL_MS);

  let syncRunId: string | null = null;
  let resolvedTenantId: string | null = null;

  try {
    const claims = await verifyJwt(event.headers?.authorization ?? event.headers?.Authorization);
    const tenantId = extractTenantIdFromPath(event.rawPath);
    resolvedTenantId = tenantId;

    const bodyText = decodeBody(event);
    let body: unknown = {};
    if (bodyText) {
      try { body = JSON.parse(bodyText); }
      catch { throw new ValidationError('Request body is not valid JSON'); }
    }
    const parsed = RequestBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(`Invalid request: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }
    validateDateRange(parsed.data.from, parsed.data.to);

    const userId = await resolveUserId(claims.cognitoSub, claims.email);
    await verifyMembership(tenantId, userId, claims.cognitoSub);

    syncRunId = await withRlsContext({ cognitoSub: 'system', tenantId }, async (client) =>
      createSyncRun(client, {
        tenantId,
        triggeredBy: 'manual',
        dateRangeFrom: parsed.data.from ?? null,
        dateRangeTo: parsed.data.to ?? null,
      }),
    );
    writeEvent(responseStream, {
      type: 'run-started',
      syncRunId,
      dateRange: { from: parsed.data.from ?? null, to: parsed.data.to ?? null },
    });

    await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
      markSyncRunRunning(client, syncRunId as string),
    );

    const accounts = await loadAccounts(tenantId, parsed.data.accountIds);
    if (accounts.length === 0) {
      writeEvent(responseStream, { type: 'progress', message: 'No active bank accounts' });
      await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
        completeSyncRun(client, {
          syncRunId: syncRunId as string,
          totalAccounts: 0,
          successCount: 0,
          errorCount: 0,
          emptyCount: 0,
          userSummary: '동기화할 계좌가 없습니다',
        }),
      );
      writeEvent(responseStream, {
        type: 'done',
        syncRunId,
        totals: { accountsScanned: 0, transactionsFetched: 0, transactionsCertain: 0, transactionsUncertain: 0 },
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const { startDate, endDate } = await resolveDateRange(tenantId, parsed.data.from, parsed.data.to);

    const accountResults: AccountResult[] = [];
    for (const account of accounts) {
      const result = await processAccount(tenantId, account, syncRunId, startDate, endDate);
      accountResults.push(result);
      writeEvent(responseStream, {
        type: 'account',
        bankAccountId: result.bankAccountId,
        organization: result.organization,
        accountNumberMasked: maskAccountNumber(result.accountNumber),
        outcome: result.outcome,
        fetchedCount: result.fetchedCount,
        balanceUpdated: result.balanceUpdated,
        balance:
          result.previousBalance !== null || result.currentBalance !== null
            ? {
                previous: result.previousBalance,
                current: result.currentBalance,
                delta:
                  result.previousBalance !== null && result.currentBalance !== null
                    ? result.currentBalance - result.previousBalance
                    : null,
                currency: 'KRW',
              }
            : null,
        codefErrorCode: result.codefErrorCode,
        codefErrorMessage: result.codefErrorMessage,
        userMessage: result.userMessage,
      });
    }

    await withRlsContext({ cognitoSub: 'system', tenantId }, async (client) => {
      for (const r of accountResults) {
        await recordAccountOutcome(client, {
          syncRunId: syncRunId as string,
          tenantId,
          bankAccountId: r.bankAccountId,
          organization: r.organization,
          accountNumber: r.accountNumber,
          outcome: r.outcome,
          codefErrorCode: r.codefErrorCode,
          codefErrorMessage: r.codefErrorMessage,
          userMessage: r.userMessage,
          fetchedCount: r.fetchedCount,
          balanceUpdated: r.balanceUpdated,
          previousBalance: r.previousBalance,
          currentBalance: r.currentBalance,
        });
      }
    });

    const allNewIds = accountResults.flatMap((r) => r.newRawTxIds);
    let certainCount = 0;
    let uncertainCount = 0;
    for (const rawTxId of allNewIds) {
      try {
        const outcome = await classifyRawTransaction(tenantId, syncRunId, rawTxId);
        if (!outcome) continue;
        if (outcome.status === 'certain') certainCount += 1;
        else uncertainCount += 1;
        writeEvent(responseStream, {
          type: 'classification',
          rawTransactionId: outcome.rawTransactionId,
          sourceAccount: outcome.sourceAccount,
          occurredAt: outcome.occurredAt.toISOString(),
          entryDate: outcome.occurredAt.toISOString().slice(0, 10),
          counterparty: outcome.counterparty,
          memo: outcome.counterparty,
          amount: outcome.amount,
          currency: 'KRW',
          status: outcome.status,
          origin: outcome.origin,
          confidence: outcome.confidence,
          ruleId: outcome.ruleId,
          lines: outcome.lines,
          journalEntryId: outcome.journalEntryId,
        });
      } catch (err) {
        logger.error({ err, rawTransactionId: rawTxId, syncRunId }, 'Classify failed for raw_transaction');
        writeEvent(responseStream, {
          type: 'classification-error',
          rawTransactionId: rawTxId,
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    const totalFetched = accountResults.reduce((sum, r) => sum + r.fetchedCount, 0);
    const successCount = accountResults.filter((r) => r.outcome === 'success').length;
    const errorCount = accountResults.filter((r) => r.outcome === 'codef_error' || r.outcome === 'no_connection').length;
    const emptyCount = accountResults.filter((r) => r.outcome === 'empty_result' || r.outcome === 'balance_only').length;
    await withRlsContext({ cognitoSub: 'system', tenantId }, (client) =>
      completeSyncRun(client, {
        syncRunId: syncRunId as string,
        totalAccounts: accountResults.length,
        successCount,
        errorCount,
        emptyCount,
        userSummary: summarize(accountResults),
      }),
    );

    writeEvent(responseStream, {
      type: 'done',
      syncRunId,
      totals: {
        accountsScanned: accountResults.length,
        accountsSucceeded: successCount,
        accountsFailed: errorCount,
        transactionsFetched: totalFetched,
        transactionsCertain: certainCount,
        transactionsUncertain: uncertainCount,
      },
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    const status = err instanceof AppError ? err.statusCode : 500;
    const message =
      err instanceof AppError ? err.userMessage : err instanceof Error ? err.message : 'internal error';
    writeEvent(responseStream, { type: 'error', status, reason: message });
    if (syncRunId && resolvedTenantId) {
      try {
        await withRlsContext({ cognitoSub: 'system', tenantId: resolvedTenantId }, (client) =>
          failSyncRun(client, syncRunId as string, message),
        );
      } catch (recordErr) {
        logger.error({ err: recordErr }, 'Failed to record sync_run failure');
      }
    }
    if (!(err instanceof AppError)) {
      const mapped = toHttpErrorResponse(err, { path: event.rawPath ?? '/fs/sync' });
      logger.error({ err, mapped }, 'fs-sync-stream unhandled');
    }
    writeEvent(responseStream, { type: 'done', syncRunId, durationMs: Date.now() - startedAt, failed: true });
  } finally {
    clearInterval(heartbeat);
    await closeSseStream(responseStream);
  }
};

interface AwsLambdaStreamingGlobal {
  streamifyResponse(
    fn: (event: FunctionUrlEvent, responseStream: ResponseStream) => Promise<void>,
  ): (event: FunctionUrlEvent, responseStream: ResponseStream) => Promise<void>;
}

const guardedHandler = withStreamingErrorBoundary({ path: '/fs/sync' }, handlerImpl);
const streamify = (globalThis as unknown as { awslambda?: AwsLambdaStreamingGlobal }).awslambda?.streamifyResponse;

export const handler = streamify ? streamify(guardedHandler) : guardedHandler;
