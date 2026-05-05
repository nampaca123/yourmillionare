// Unit tests for auth-claims.mapper parseClaims.

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { parseClaims } from '../src/infrastructure/inbound/http/auth-claims.mapper.js';
import { UnauthorizedError } from '../src/shared/errors/app-error.js';

describe('parseClaims', () => {
  const validClaims = {
    sub: randomUUID(),
    email: 'user@example.com',
    token_use: 'id',
    aud: 'client-id-123',
  };

  it('should return cognitoSub and email when claims are a valid ID Token', () => {
    const result = parseClaims(validClaims);

    expect(result.cognitoSub).toBe(validClaims.sub);
    expect(result.email).toBe(validClaims.email);
  });

  it('should throw UnauthorizedError when token_use is access instead of id', () => {
    const claims = { ...validClaims, token_use: 'access' };

    expect(() => parseClaims(claims)).toThrow(UnauthorizedError);
  });

  it('should throw UnauthorizedError when sub is not a valid UUID', () => {
    const claims = { ...validClaims, sub: 'not-a-uuid' };

    expect(() => parseClaims(claims)).toThrow(UnauthorizedError);
  });

  it('should throw UnauthorizedError when email is missing', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { email: _, ...claims } = validClaims;

    expect(() => parseClaims(claims)).toThrow(UnauthorizedError);
  });

  it('should throw UnauthorizedError when claims is null', () => {
    expect(() => parseClaims(null)).toThrow(UnauthorizedError);
  });
});
