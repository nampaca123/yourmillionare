// Parses and validates Cognito ID Token JWT claims from API Gateway context.

import { z } from 'zod';
import { UnauthorizedError } from '@ym/shared-errors';

const ClaimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
  token_use: z.literal('id'),
  aud: z.string(),
  'cognito:groups': z.array(z.string()).optional(),
});

export interface AuthClaims {
  cognitoSub: string;
  email: string;
  groups: ReadonlyArray<string>;
}

export const parseClaims = (raw: unknown): AuthClaims => {
  const parsed = ClaimsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UnauthorizedError(`Invalid JWT claims: ${parsed.error.message}`);
  }
  return {
    cognitoSub: parsed.data.sub,
    email: parsed.data.email,
    groups: parsed.data['cognito:groups'] ?? [],
  };
};
