// Input validation schema for POST /journal/entries.

import { z } from 'zod';

const LineSchema = z.object({
  lineNo: z.number().int().positive(),
  accountCode: z.string().min(1).max(10),
  debit: z.number().min(0),
  credit: z.number().min(0),
  memo: z.string().max(500).optional(),
});

export const CreateEntryBodySchema = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'entryDate must be YYYY-MM-DD'),
  description: z.string().max(500).optional(),
  lines: z.array(LineSchema).min(2),
});

export type CreateEntryBody = z.infer<typeof CreateEntryBodySchema>;
