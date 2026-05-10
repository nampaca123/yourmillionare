// Schema: Zod validation for bank account confirmation request body.

import { z } from 'zod';

export const AddBankAccountBodySchema = z.object({
  organization: z.string().length(4),
  accountNumber: z.string().min(1).max(50),
});

export type AddBankAccountBody = z.infer<typeof AddBankAccountBodySchema>;
