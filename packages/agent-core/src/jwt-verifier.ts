// JWT verifier for Lambda Function URLs (no API Gateway authorizer). Uses aws-jwt-verify with in-memory JWKS cache.

import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { UnauthorizedError } from '@ym/shared-errors';

export interface VerifiedClaims {
  readonly cognitoSub: string;
  readonly email: string;
  readonly groups: ReadonlyArray<string>;
}

let cachedVerifier: ReturnType<typeof CognitoJwtVerifier.create<{ userPoolId: string; clientId: string; tokenUse: 'id' }>> | undefined;

const buildVerifier = (): ReturnType<typeof CognitoJwtVerifier.create<{ userPoolId: string; clientId: string; tokenUse: 'id' }>> => {
  if (cachedVerifier) return cachedVerifier;
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_USER_POOL_CLIENT_ID;
  if (!userPoolId || !clientId) {
    throw new Error('COGNITO_USER_POOL_ID and COGNITO_USER_POOL_CLIENT_ID env vars are required for Function URL JWT verification');
  }
  cachedVerifier = CognitoJwtVerifier.create({
    userPoolId,
    clientId,
    tokenUse: 'id',
  });
  return cachedVerifier;
};

const parseGroups = (raw: unknown): ReadonlyArray<string> => {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('[') && t.endsWith(']')) {
      return t.slice(1, -1).split(/[\s,]+/).filter(Boolean);
    }
    return t.length > 0 ? t.split(/[\s,]+/).filter(Boolean) : [];
  }
  return [];
};

export const verifyJwt = async (authorizationHeader: string | undefined): Promise<VerifiedClaims> => {
  if (!authorizationHeader || !authorizationHeader.toLowerCase().startsWith('bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header');
  }
  const token = authorizationHeader.slice('bearer '.length).trim();
  if (!token) throw new UnauthorizedError('Empty Bearer token');

  const verifier = buildVerifier();
  try {
    const payload = (await verifier.verify(token)) as unknown as Record<string, unknown>;
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    const email = typeof payload.email === 'string' ? payload.email : '';
    if (!sub || !email) throw new UnauthorizedError('JWT missing sub or email claim');
    return { cognitoSub: sub, email, groups: parseGroups(payload['cognito:groups']) };
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError(`Invalid JWT: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
};
