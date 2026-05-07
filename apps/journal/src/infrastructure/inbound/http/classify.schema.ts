// Input validation schema for POST /journal/classify.

import { z } from 'zod';

export const ClassifyBodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  amount: z.number().positive('amount must be positive'),
  counterparty: z.string().min(1).max(200),
  memo: z.string().min(1).max(500),
});

export type ClassifyBody = z.infer<typeof ClassifyBodySchema>;
