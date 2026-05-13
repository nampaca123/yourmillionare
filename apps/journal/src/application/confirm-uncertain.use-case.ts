// Use case: promote a pending uncertain draft to a certain journal_entry, optionally with user-corrected lines.

import { randomUUID } from 'node:crypto';
import { createJournalEntry } from '@ym/journal-core';
import { ConflictError, NotFoundError } from '@ym/shared-errors';
import type { PgJournalRepository } from '../infrastructure/outbound/pg/pg-journal.repository.js';
import type { DraftRepository } from './ports/draft.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

const SOURCE = 'codef_bank' as const;

interface CorrectedLineInput {
  readonly lineNo: number;
  readonly accountCode: string;
  readonly debit: number;
  readonly credit: number;
  readonly memo?: string | null | undefined;
}

export interface ConfirmUncertainResult {
  readonly rawTransactionId: string;
  readonly journalEntryId: string;
  readonly status: 'certain';
  readonly entryDate: string;
}

export class ConfirmUncertainUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly drafts: DraftRepository,
    private readonly journalRepo: PgJournalRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    rawTransactionId: string;
    correctedLines?: ReadonlyArray<CorrectedLineInput>;
  }): Promise<ConfirmUncertainResult> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });

    const draft = await this.drafts.findPending({
      tenantId: params.tenantId,
      rawTransactionId: params.rawTransactionId,
    });

    if (!draft) {
      throw new NotFoundError(`Uncertain classification not found for raw transaction ${params.rawTransactionId}`);
    }

    type Line = { lineNo: number; accountCode: string; debit: number; credit: number; memo?: string };
    const toLine = (l: { lineNo: number; accountCode: string; debit: number; credit: number; memo?: string | null | undefined }): Line => {
      const base = {
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        debit: l.debit,
        credit: l.credit,
      };
      return l.memo != null && l.memo.length > 0 ? { ...base, memo: l.memo } : base;
    };
    const linesInput: Line[] = params.correctedLines && params.correctedLines.length > 0
      ? params.correctedLines.map(toLine)
      : draft.draftLines.map(toLine);

    const entryDate = draft.occurredAt.toISOString().slice(0, 10);
    const journalEntryId = randomUUID();

    const entry = createJournalEntry({
      tenantId: params.tenantId,
      entryDate,
      source: SOURCE,
      sourceRefId: draft.rawTransactionId,
      createdBy: params.userId,
      description: draft.counterparty ?? 'Unknown',
      lines: linesInput,
    });
    const entryWithId = { ...entry, id: journalEntryId };

    try {
      await this.drafts.acceptInTransaction({
        tenantId: params.tenantId,
        rawTransactionId: params.rawTransactionId,
        journalEntryId,
        correctedLines: params.correctedLines ?? null,
        aiConfidence: draft.aiConfidence,
        aiModel: draft.ruleId,
        aiInputTokens: null,
        aiOutputTokens: null,
        counterparty: draft.counterparty,
        entryDate,
        work: async (client) => {
          await this.journalRepo.saveEntriesAtomically(client, [entryWithId]);
        },
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('duplicate')) {
        throw new ConflictError(`Uncertain ${params.rawTransactionId} already confirmed`);
      }
      throw err;
    }

    return {
      rawTransactionId: params.rawTransactionId,
      journalEntryId,
      status: 'certain',
      entryDate,
    };
  }
}
