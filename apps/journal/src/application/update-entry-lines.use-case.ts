// Use case: replace the lines of an uncertain journal entry (in-place edit). Certain entries must be reversed first.

import { ConflictError, NotFoundError, ValidationError } from '@ym/shared-errors';
import type {
  CorrectedLineInput,
  EntriesRepository,
  EntryRow,
} from './ports/entries.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

const assertBalanced = (lines: ReadonlyArray<CorrectedLineInput>): void => {
  const totalDebit = lines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredit = lines.reduce((sum, l) => sum + l.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.001) {
    throw new ValidationError(
      `Lines are unbalanced: debit ${totalDebit} <> credit ${totalCredit}`,
    );
  }
};

export class UpdateEntryLinesUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly entries: EntriesRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    entryId: string;
    lines: ReadonlyArray<CorrectedLineInput>;
  }): Promise<EntryRow> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });

    if (params.lines.length < 2) {
      throw new ValidationError('At least two lines (debit + credit) are required');
    }
    assertBalanced(params.lines);

    const existing = await this.entries.findById({
      tenantId: params.tenantId,
      entryId: params.entryId,
    });
    if (!existing) throw new NotFoundError(`Journal entry ${params.entryId} not found`);
    if (existing.confidenceStatus !== 'uncertain') {
      throw new ConflictError(
        `Entry ${params.entryId} is ${existing.confidenceStatus}; only uncertain entries are editable in-place`,
      );
    }

    await this.entries.replaceLines({
      tenantId: params.tenantId,
      entryId: params.entryId,
      lines: params.lines,
    });

    const refreshed = await this.entries.findById({
      tenantId: params.tenantId,
      entryId: params.entryId,
    });
    if (!refreshed) throw new NotFoundError(`Journal entry ${params.entryId} vanished after update`);
    return refreshed;
  }
}
