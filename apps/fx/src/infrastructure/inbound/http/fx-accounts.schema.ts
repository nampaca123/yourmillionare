// Zod schemas for manual FX account inbound bodies — USD whitelist + balance limits.

import { z } from 'zod';

const MAX_BALANCE_FCY = 1e12;

export const RegisterFxAccountBodySchema = z.object({
  currency: z.literal('USD'),
  balance: z.number().positive().max(MAX_BALANCE_FCY),
  bankLabel: z.string().min(1).max(40).optional(),
});

export const UpdateFxBalanceBodySchema = z.object({
  balance: z.number().positive().max(MAX_BALANCE_FCY),
});

export type RegisterFxAccountBody = z.infer<typeof RegisterFxAccountBodySchema>;
export type UpdateFxBalanceBody = z.infer<typeof UpdateFxBalanceBodySchema>;
