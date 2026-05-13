// Unit tests for verifyJwt — Function URL Cognito ID Token verification.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UnauthorizedError } from '@ym/shared-errors';

const verifyMock = vi.fn();

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: vi.fn(() => ({ verify: verifyMock })),
  },
}));

const ORIGINAL_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const ORIGINAL_CLIENT_ID = process.env.COGNITO_USER_POOL_CLIENT_ID;

describe('verifyJwt', () => {
  beforeEach(async () => {
    process.env.COGNITO_USER_POOL_ID = 'ap-northeast-2_test';
    process.env.COGNITO_USER_POOL_CLIENT_ID = 'test-client';
    const { __test__ } = await import('../src/verify-jwt.function-url.js');
    __test__.resetCache();
    verifyMock.mockReset();
  });

  afterEach(() => {
    if (ORIGINAL_USER_POOL_ID === undefined) delete process.env.COGNITO_USER_POOL_ID;
    else process.env.COGNITO_USER_POOL_ID = ORIGINAL_USER_POOL_ID;
    if (ORIGINAL_CLIENT_ID === undefined) delete process.env.COGNITO_USER_POOL_CLIENT_ID;
    else process.env.COGNITO_USER_POOL_CLIENT_ID = ORIGINAL_CLIENT_ID;
  });

  it('should return claims when token is valid', async () => {
    verifyMock.mockResolvedValueOnce({
      sub: 'user-uuid',
      email: 'a@b.com',
      'cognito:groups': ['ym-tax-admin'],
    });
    const { verifyJwt } = await import('../src/verify-jwt.function-url.js');

    const result = await verifyJwt('Bearer test-token');

    expect(result.cognitoSub).toBe('user-uuid');
    expect(result.email).toBe('a@b.com');
    expect(result.groups).toEqual(['ym-tax-admin']);
  });

  it('should throw UnauthorizedError when authorization header is missing', async () => {
    const { verifyJwt } = await import('../src/verify-jwt.function-url.js');

    const act = verifyJwt(undefined);

    await expect(act).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('should throw UnauthorizedError when Bearer prefix is absent', async () => {
    const { verifyJwt } = await import('../src/verify-jwt.function-url.js');

    const act = verifyJwt('Basic abc');

    await expect(act).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('should throw UnauthorizedError when sub claim is missing', async () => {
    verifyMock.mockResolvedValueOnce({ email: 'a@b.com' });
    const { verifyJwt } = await import('../src/verify-jwt.function-url.js');

    const act = verifyJwt('Bearer test-token');

    await expect(act).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('should throw UnauthorizedError when verifier throws', async () => {
    verifyMock.mockRejectedValueOnce(new Error('token expired'));
    const { verifyJwt } = await import('../src/verify-jwt.function-url.js');

    const act = verifyJwt('Bearer test-token');

    await expect(act).rejects.toMatchObject({ message: expect.stringContaining('token expired') });
  });

  it('should tolerate string-flattened cognito:groups in [g1 g2] form', async () => {
    verifyMock.mockResolvedValueOnce({
      sub: 'uuid',
      email: 'a@b.com',
      'cognito:groups': '[ym-tax-admin ym-other]',
    });
    const { verifyJwt } = await import('../src/verify-jwt.function-url.js');

    const result = await verifyJwt('Bearer t');

    expect(result.groups).toEqual(['ym-tax-admin', 'ym-other']);
  });

  it('should throw UnauthorizedError when env vars are unset', async () => {
    delete process.env.COGNITO_USER_POOL_ID;
    const { verifyJwt, __test__ } = await import('../src/verify-jwt.function-url.js');
    __test__.resetCache();

    const act = verifyJwt('Bearer t');

    await expect(act).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
