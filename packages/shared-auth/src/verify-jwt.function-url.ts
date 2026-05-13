// Verifies Cognito ID Tokens for Lambda Function URL handlers, sharing the cognito:groups flattening logic with parseClaims.

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { UnauthorizedError } from '@ym/shared-errors';
import type { AuthClaims } from './auth-claims.mapper.js';

const BEARER_PREFIX = 'bearer ';

let cachedVerifier:
  | ReturnType<typeof CognitoJwtVerifier.create<{ userPoolId: string; clientId: string; tokenUse: 'id' }>>
  | undefined;

const buildVerifier = (): ReturnType<
  typeof CognitoJwtVerifier.create<{ userPoolId: string; clientId: string; tokenUse: 'id' }>
> => {
  if (cachedVerifier) return cachedVerifier;
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_USER_POOL_CLIENT_ID;
  if (!userPoolId || !clientId) {
    throw new UnauthorizedError(
      'COGNITO_USER_POOL_ID and COGNITO_USER_POOL_CLIENT_ID env vars are required for Function URL JWT verification',
    );
  }
  cachedVerifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'id' });
  return cachedVerifier;
};

const parseGroupsClaim = (raw: unknown): ReadonlyArray<string> => {
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string');
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return trimmed.slice(1, -1).split(/[\s,]+/).filter(Boolean);
    }
    return trimmed.length > 0 ? trimmed.split(/[\s,]+/).filter(Boolean) : [];
  }
  return [];
};

export const verifyJwt = async (authorizationHeader: string | undefined): Promise<AuthClaims> => {
  if (!authorizationHeader || !authorizationHeader.toLowerCase().startsWith(BEARER_PREFIX)) {
    throw new UnauthorizedError('Missing or malformed Authorization header');
  }
  const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  if (!token) throw new UnauthorizedError('Empty Bearer token');

  const verifier = buildVerifier();
  let payload: Record<string, unknown>;
  try {
    payload = (await verifier.verify(token)) as unknown as Record<string, unknown>;
  } catch (err) {
    throw new UnauthorizedError(`Invalid JWT: ${err instanceof Error ? err.message : 'unknown error'}`);
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload.email === 'string' ? payload.email : '';
  if (!sub || !email) throw new UnauthorizedError('JWT missing sub or email claim');

  return {
    cognitoSub: sub,
    email,
    groups: parseGroupsClaim(payload['cognito:groups']),
  };
};

export const __test__ = {
  parseGroupsClaim,
  resetCache: (): void => {
    cachedVerifier = undefined;
  },
};
