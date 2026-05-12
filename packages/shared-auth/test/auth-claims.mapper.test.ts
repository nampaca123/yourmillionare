// Unit tests for parseClaims — covers API Gateway HTTP authorizer flattening of array claims.

import { describe, it, expect } from 'vitest';
import { ForbiddenError, UnauthorizedError } from '@ym/shared-errors';
import { parseClaims, requireGroup } from '../src/auth-claims.mapper.js';

const baseClaims = {
  sub: '11111111-1111-1111-1111-111111111111',
  email: 'user@example.com',
  token_use: 'id',
  aud: 'test-client-id',
};

describe('parseClaims', () => {
  it('should parse valid claims without groups', () => {
    const result = parseClaims(baseClaims);

    expect(result.cognitoSub).toBe(baseClaims.sub);
    expect(result.email).toBe(baseClaims.email);
    expect(result.groups).toEqual([]);
  });

  it('should parse array-typed cognito:groups (raw JWT shape)', () => {
    const result = parseClaims({ ...baseClaims, 'cognito:groups': ['ym-tax-admin', 'ym-other'] });

    expect(result.groups).toEqual(['ym-tax-admin', 'ym-other']);
  });

  it('should parse string-flattened cognito:groups in [g1 g2] form (API GW shape)', () => {
    const result = parseClaims({ ...baseClaims, 'cognito:groups': '[ym-tax-admin ym-other]' });

    expect(result.groups).toEqual(['ym-tax-admin', 'ym-other']);
  });

  it('should parse single-group flattened string [ym-tax-admin]', () => {
    const result = parseClaims({ ...baseClaims, 'cognito:groups': '[ym-tax-admin]' });

    expect(result.groups).toEqual(['ym-tax-admin']);
  });

  it('should parse comma-separated flattened string a,b,c', () => {
    const result = parseClaims({ ...baseClaims, 'cognito:groups': 'a,b,c' });

    expect(result.groups).toEqual(['a', 'b', 'c']);
  });

  it('should return empty groups when flattened string is empty', () => {
    const result = parseClaims({ ...baseClaims, 'cognito:groups': '' });

    expect(result.groups).toEqual([]);
  });

  it('should accept non-UUID sub for federated providers', () => {
    const result = parseClaims({ ...baseClaims, sub: 'Google_117498919707818623282' });

    expect(result.cognitoSub).toBe('Google_117498919707818623282');
  });

  it('should throw UnauthorizedError when token_use is not id', () => {
    expect(() => parseClaims({ ...baseClaims, token_use: 'access' })).toThrow(UnauthorizedError);
  });

  it('should throw UnauthorizedError when email is invalid', () => {
    expect(() => parseClaims({ ...baseClaims, email: 'not-an-email' })).toThrow(UnauthorizedError);
  });

  it('should throw UnauthorizedError when sub is empty', () => {
    expect(() => parseClaims({ ...baseClaims, sub: '' })).toThrow(UnauthorizedError);
  });
});

describe('requireGroup', () => {
  it('should pass when claims include the required group', () => {
    const claims = parseClaims({ ...baseClaims, 'cognito:groups': ['ym-tax-admin'] });

    expect(() => requireGroup(claims, 'ym-tax-admin')).not.toThrow();
  });

  it('should throw ForbiddenError when required group is missing', () => {
    const claims = parseClaims({ ...baseClaims, 'cognito:groups': ['other'] });

    expect(() => requireGroup(claims, 'ym-tax-admin')).toThrow(ForbiddenError);
  });
});
