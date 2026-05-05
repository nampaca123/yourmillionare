// Zod schema for POST /tenants request body validation.

import { z } from 'zod';

export const CreateTenantBodySchema = z.object({
  legalName: z.string().min(1).max(100),
  displayName: z.string().min(1).max(100),
  bizRegNo: z.string().min(1).max(12),
});

export type CreateTenantBody = z.infer<typeof CreateTenantBodySchema>;
