// JournalLine value object: one side of a double-entry line, with debit XOR credit.

export interface JournalLine {
  readonly lineNo: number;
  readonly accountCode: string;
  readonly debit: number;
  readonly credit: number;
  readonly memo?: string;
}

export const createJournalLine = (params: {
  lineNo: number;
  accountCode: string;
  debit: number;
  credit: number;
  memo?: string;
}): JournalLine => {
  if (params.debit < 0 || params.credit < 0) throw new Error('Debit and credit must be non-negative.');
  if (params.debit > 0 && params.credit > 0) throw new Error('A journal line cannot have both debit and credit amounts.');
  if (params.debit === 0 && params.credit === 0) throw new Error('A journal line must have either a debit or credit amount.');
  return { ...params };
};
