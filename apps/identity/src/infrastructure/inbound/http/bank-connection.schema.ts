// Schema: Zod validation for POST /tenants/{tenantId}/bank-connections request body.

import { z } from 'zod';

export const ConnectBankBodySchema = z.object({
  organization: z.string().length(4),
  loginId: z.string().min(1).max(100),
  loginPassword: z.string().min(1).max(200),
  birthDate: z.string().regex(/^\d{8}$/).optional(),
});

export type ConnectBankBody = z.infer<typeof ConnectBankBodySchema>;
