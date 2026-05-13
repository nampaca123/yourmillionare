// Port: full-fidelity journal_entries read/write for the unified /entries CRUD (no separate draft table).

import type { PoolClient } from 'pg';

export type ConfidenceStatus = 'certain' | 'uncertain' | 'discarded';
export type ClassificationOrigin = 'manual' | 'heuristic' | 'ai' | 'ai_low_conf';

export interface EntryLine {
  readonly lineNo: number;
  readonly accountCode: string;
  readonly accountName: string | null;
  readonly accountType: string | null;
  readonly debit: number;
  readonly credit: number;
  readonly memo: string | null;
}

export interface EntryRow {
  readonly id: string;
  readonly tenantId: string;
  readonly entryDate: string;
  readonly postingDate: string;
  readonly source: string;
  readonly sourceRefId: string | null;
  readonly description: string | null;
  readonly status: 'draft' | 'posted' | 'reversed';
  readonly confidenceStatus: ConfidenceStatus;
  readonly confidence: number | null;
  readonly origin: ClassificationOrigin | null;
  readonly syncRunId: string | null;
  readonly aiModel: string | null;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly lines: ReadonlyArray<EntryLine>;
}

export interface ListEntriesInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cognitoSub: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly limit: number;
  readonly offset: number;
  readonly confidenceStatus: ConfidenceStatus | 'all';
}

export interface CorrectedLineInput {
  readonly lineNo: number;
  readonly accountCode: string;
  readonly debit: number;
  readonly credit: number;
  readonly memo?: string | null | undefined;
}

export interface EntriesRepository {
  list(input: ListEntriesInput): Promise<ReadonlyArray<EntryRow>>;
  findById(input: { tenantId: string; entryId: string }): Promise<EntryRow | null>;
  replaceLines(input: {
    tenantId: string;
    entryId: string;
    lines: ReadonlyArray<CorrectedLineInput>;
    work?: (client: PoolClient) => Promise<void>;
  }): Promise<void>;
  updateConfidenceStatus(input: {
    tenantId: string;
    entryId: string;
    fromStatus: ConfidenceStatus;
    toStatus: ConfidenceStatus;
    promoteToPosted: boolean;
  }): Promise<boolean>;
}
