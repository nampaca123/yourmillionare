// Schema: query parameters for GET /tenants/{tenantId}/journal/entries.

import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const ListJournalEntriesQuerySchema = z.object({
  from: z.string().regex(ISO_DATE, 'from must be YYYY-MM-DD'),
  to: z.string().regex(ISO_DATE, 'to must be YYYY-MM-DD'),
  limit: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 20 : parseInt(v, 10)))
    .pipe(z.number().int().min(1).max(100)),
  offset: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 0 : parseInt(v, 10)))
    .pipe(z.number().int().min(0)),
});

export type ListJournalEntriesQuery = z.infer<typeof ListJournalEntriesQuerySchema>;
