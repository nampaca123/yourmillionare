// Repository: pending-draft read + accept-in-transaction (promote to journal_entries + ai_decisions audit).

import { withRlsContext } from './pg-rls.context.js';
import type { DraftRepository, DraftToAccept } from '../../../application/ports/draft.repository.port.js';

interface PendingDraftRow {
  raw_transaction_id: string;
  tenant_id: string;
  draft_lines: unknown;
  origin: 'heuristic' | 'ai_low_conf';
  ai_confidence: string | null;
  rule_id: string | null;
  occurred_at: Date;
  counterparty: string | null;
}

export class PgDraftRepository implements DraftRepository {
  async findPending({
    tenantId,
    rawTransactionId,
  }: {
    tenantId: string;
    rawTransactionId: string;
  }): Promise<DraftToAccept | null> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<PendingDraftRow>(
        `SELECT d.raw_transaction_id, d.tenant_id, d.draft_lines, d.origin,
                d.ai_confidence::text, d.rule_id,
                rt.occurred_at, rt.counterparty
         FROM journal_entry_draft d
         JOIN raw_transactions rt ON rt.id = d.raw_transaction_id
         WHERE d.raw_transaction_id = $1 AND d.tenant_id = $2 AND d.status = 'pending'`,
        [rawTransactionId, tenantId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        rawTransactionId: row.raw_transaction_id,
        tenantId: row.tenant_id,
        draftLines: row.draft_lines as DraftToAccept['draftLines'],
        origin: row.origin,
        aiConfidence: row.ai_confidence ? Number.parseFloat(row.ai_confidence) : null,
        ruleId: row.rule_id,
        occurredAt: row.occurred_at,
        counterparty: row.counterparty,
      };
    });
  }

  async acceptInTransaction(input: {
    tenantId: string;
    rawTransactionId: string;
    journalEntryId: string;
    correctedLines: DraftToAccept['draftLines'] | null;
    aiConfidence: number | null;
    aiModel: string | null;
    aiInputTokens: number | null;
    aiOutputTokens: number | null;
    counterparty: string | null;
    entryDate: string;
    work: (client: import('pg').PoolClient) => Promise<void>;
  }): Promise<void> {
    await withRlsContext({ tenantId: input.tenantId, cognitoSub: 'system' }, async (client) => {
      await input.work(client);

      await client.query(
        `UPDATE journal_entry_draft
            SET status = 'accepted',
                accepted_at = now(),
                accepted_entry_id = $1
          WHERE raw_transaction_id = $2 AND tenant_id = $3 AND status = 'pending'`,
        [input.journalEntryId, input.rawTransactionId, input.tenantId],
      );

      await client.query(
        `INSERT INTO ai_decisions (entry_id, tenant_id, model, input_tokens, output_tokens, confidence, user_corrected, corrected_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (entry_id) DO UPDATE
           SET user_corrected = TRUE,
               corrected_at = now()`,
        [
          input.journalEntryId,
          input.tenantId,
          input.aiModel ?? 'user-accepted',
          input.aiInputTokens,
          input.aiOutputTokens,
          input.aiConfidence,
          input.correctedLines !== null,
        ],
      );
    });
  }
}
