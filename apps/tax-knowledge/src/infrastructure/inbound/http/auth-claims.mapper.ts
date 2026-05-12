// Parses Cognito ID Token claims + extracts the tax-admin group flag for /admin/* routes.

import { z } from 'zod';
import { ForbiddenError, UnauthorizedError } from '@ym/shared-errors';

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
  isTaxAdmin: boolean;
}

const ADMIN_GROUP = process.env.ADMIN_COGNITO_GROUP ?? 'ym-tax-admin';

export const parseClaims = (raw: unknown): AuthClaims => {
  const parsed = ClaimsSchema.safeParse(raw);
  if (!parsed.success) throw new UnauthorizedError(`Invalid JWT claims: ${parsed.error.message}`);
  const groups = parsed.data['cognito:groups'] ?? [];
  return {
    cognitoSub: parsed.data.sub,
    email: parsed.data.email,
    groups,
    isTaxAdmin: groups.includes(ADMIN_GROUP),
  };
};

export const requireTaxAdmin = (claims: AuthClaims): void => {
  if (!claims.isTaxAdmin) {
    throw new ForbiddenError('Tax admin group membership is required');
  }
};
