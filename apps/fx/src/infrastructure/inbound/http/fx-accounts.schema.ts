// Zod schemas for FX account inbound bodies/queries — USD whitelist + balance limits + CODEF link.

import { z } from 'zod';

const MAX_BALANCE_FCY = 1e12;
const ORGANIZATION_PATTERN = /^[0-9]{4}$/;

export const RegisterFxAccountBodySchema = z.object({
  currency: z.literal('USD'),
  balance: z.number().positive().max(MAX_BALANCE_FCY),
  bankLabel: z.string().min(1).max(40).optional(),
});

export const UpdateFxBalanceBodySchema = z.object({
  balance: z.number().positive().max(MAX_BALANCE_FCY),
});

export const DiscoverFxAccountsQuerySchema = z.object({
  organization: z.string().regex(ORGANIZATION_PATTERN, 'organization must be a 4-digit CODEF org code'),
});

export const LinkFxAccountBodySchema = z.object({
  organization: z.string().regex(ORGANIZATION_PATTERN, 'organization must be a 4-digit CODEF org code'),
  accountNumber: z.string().min(1).max(50),
  bankLabel: z.string().min(1).max(40).optional(),
});

export type RegisterFxAccountBody = z.infer<typeof RegisterFxAccountBodySchema>;
export type UpdateFxBalanceBody = z.infer<typeof UpdateFxBalanceBodySchema>;
export type DiscoverFxAccountsQuery = z.infer<typeof DiscoverFxAccountsQuerySchema>;
export type LinkFxAccountBody = z.infer<typeof LinkFxAccountBodySchema>;
