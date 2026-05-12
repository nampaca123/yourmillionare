// Lambda entry point: SQS-triggered worker that classifies raw transactions and creates journal entries.

import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import {
  BedrockConverseClassifier,
  DeterministicStubClassifier,
  DdbCacheProjectorAdapter,
  PgJournalRepository,
  createJournalEntry,
  K_IFRS_DEFAULT_ACCOUNTS,
} from '@ym/journal-core';
import type { TransactionClassifier } from '@ym/journal-core';
import { getPool } from '../../outbound/pg/pg-pool.client.js';
import { findById, markDispatched } from '../../outbound/pg/pg-raw-transaction.repository.js';
import { logger } from '../../../shared/logging/logger.js';

const CLASSIFY_MODE = process.env.CLASSIFY_MODE ?? 'bedrock';
const SYSTEM_USER_UUID = process.env.SYSTEM_USER_UUID ?? '00000000-0000-0000-0000-000000000001';
const SOURCE = 'codef_bank' as const;
const DRAFT_CONFIDENCE_THRESHOLD = Number.parseFloat(process.env.DRAFT_CONFIDENCE_THRESHOLD ?? '0.5');

const classifier: TransactionClassifier =
  CLASSIFY_MODE === 'bedrock' ? new BedrockConverseClassifier() : new DeterministicStubClassifier();

const journalRepo = new PgJournalRepository();
const cacheProjector = new DdbCacheProjectorAdapter();

interface ClassifyTask {
  rawTransactionId: string;
  tenantId: string;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    const log = logger.child({ messageId: record.messageId });
    try {
      let task: ClassifyTask;
      try {
        task = JSON.parse(record.body) as ClassifyTask;
      } catch {
        log.error({ body: record.body }, 'Failed to parse SQS message body');
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const { rawTransactionId, tenantId } = task;

      const pool = await getPool();
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query('RESET app.cognito_sub');
        await client.query('RESET app.current_user_id');
        await client.query('RESET app.current_tenant_id');
        await client.query("SELECT set_config('app.cognito_sub', 'system', true)");
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

        const seedValues = K_IFRS_DEFAULT_ACCOUNTS
          .map((_, i) => {
            const b = i * 6;
            return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
          })
          .join(', ');
        const seedParams = K_IFRS_DEFAULT_ACCOUNTS.flatMap((a) => [
          tenantId, a.code, a.name, a.displayName, a.type, a.normalBalance,
        ]);
        await client.query(
          `INSERT INTO accounts (tenant_id, code, name, display_name, type, normal_balance)
           VALUES ${seedValues}
           ON CONFLICT (tenant_id, code) DO NOTHING`,
          seedParams,
        );

        const raw = await findById(client, rawTransactionId);
        if (!raw) {
          log.warn({ rawTransactionId }, 'raw_transaction not found; skipping');
          await client.query('ROLLBACK');
          continue;
        }

        const alreadyExists = await journalRepo.existsBySourceRef(client, tenantId, rawTransactionId);
        if (alreadyExists) {
          log.info({ rawTransactionId }, 'Journal entry already exists for raw transaction; skipping');
          await client.query('ROLLBACK');
          continue;
        }

        const entryDate = raw.occurred_at.toISOString().slice(0, 10);
        const counterparty = raw.counterparty ?? 'Unknown';
        const amount = Math.abs(Number(raw.amount));

        const classifyResult = await classifier.classify({
          date: entryDate,
          amount,
          counterparty,
          memo: counterparty,
        });

        if (classifyResult.confidence < DRAFT_CONFIDENCE_THRESHOLD) {
          await client.query(
            `INSERT INTO journal_entry_draft
               (raw_transaction_id, tenant_id, draft_lines, heuristic_confidence, rule_id)
             VALUES ($1, $2, $3::jsonb, $4, $5)
             ON CONFLICT (raw_transaction_id) DO UPDATE
               SET draft_lines = EXCLUDED.draft_lines,
                   heuristic_confidence = EXCLUDED.heuristic_confidence,
                   rule_id = EXCLUDED.rule_id`,
            [
              rawTransactionId,
              tenantId,
              JSON.stringify(classifyResult.lines),
              classifyResult.confidence,
              `bedrock:${classifyResult.modelId}`,
            ],
          );
          await markDispatched(client, [rawTransactionId]);
          await client.query('COMMIT');
          log.info(
            { rawTransactionId, confidence: classifyResult.confidence, threshold: DRAFT_CONFIDENCE_THRESHOLD },
            'Low-confidence classification routed to journal_entry_draft for user review',
          );
          continue;
        }

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
        });

        const randomId = crypto.randomUUID();
        const entryWithId = { ...entry, id: randomId };

        const [saved] = await journalRepo.saveEntriesAtomically(client, [entryWithId]);

        if (saved) {
          await client.query(
            `INSERT INTO ai_decisions (entry_id, tenant_id, model, input_tokens, output_tokens, confidence)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (entry_id) DO NOTHING`,
            [
              saved.id,
              tenantId,
              classifyResult.modelId,
              classifyResult.inputTokens ?? null,
              classifyResult.outputTokens ?? null,
              classifyResult.confidence,
            ],
          );
          await client.query(
            `DELETE FROM journal_entry_draft WHERE raw_transaction_id = $1 AND tenant_id = $2`,
            [rawTransactionId, tenantId],
          );
        }

        await markDispatched(client, [rawTransactionId]);
        await client.query('COMMIT');

        if (saved) {
          try {
            await cacheProjector.projectEntry(tenantId, saved);
          } catch (cacheErr) {
            log.warn({ err: cacheErr, rawTransactionId }, 'Cache projection failed (non-fatal)');
          }
        }

        log.info({ rawTransactionId, entryId: saved?.id }, 'Transaction classified and saved');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      logger.error({ err, messageId: record.messageId }, 'Failed to process SQS record');
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
