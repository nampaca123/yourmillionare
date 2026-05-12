// Re-exports shared parseClaims plus tax-knowledge admin guard.

import { type AuthClaims, parseClaims as sharedParseClaims, requireGroup } from '@ym/shared-auth';
import { ForbiddenError } from '@ym/shared-errors';

const ADMIN_GROUP = process.env.ADMIN_COGNITO_GROUP ?? 'ym-tax-admin';

export type { AuthClaims };

export interface TaxKnowledgeAuthClaims extends AuthClaims {
  isTaxAdmin: boolean;
}

export const parseClaims = (raw: unknown): TaxKnowledgeAuthClaims => {
  const claims = sharedParseClaims(raw);
  return { ...claims, isTaxAdmin: claims.groups.includes(ADMIN_GROUP) };
};

export const requireTaxAdmin = (claims: AuthClaims): void => {
  try {
    requireGroup(claims, ADMIN_GROUP);
  } catch (err) {
    if (err instanceof ForbiddenError) throw new ForbiddenError('Tax admin group membership is required');
    throw err;
  }
};
