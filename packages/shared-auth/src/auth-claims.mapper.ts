// Parses Cognito ID Token JWT claims from API Gateway HTTP API authorizer context, tolerating array-flattening.

import { z } from 'zod';
import { ForbiddenError, UnauthorizedError } from '@ym/shared-errors';

const groupsClaim = z
  .union([
    z.array(z.string()),
    z.string().transform((s) => {
      const t = s.trim();
      if (t.startsWith('[') && t.endsWith(']')) {
        return t
          .slice(1, -1)
          .split(/[\s,]+/)
          .filter(Boolean);
      }
      return t.length > 0 ? t.split(/[\s,]+/).filter(Boolean) : [];
    }),
  ])
  .optional();

const ClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  token_use: z.literal('id'),
  aud: z.string(),
  'cognito:groups': groupsClaim,
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

export const requireGroup = (claims: AuthClaims, group: string): void => {
  if (!claims.groups.includes(group)) {
    throw new ForbiddenError(`Group membership '${group}' is required`);
  }
};
