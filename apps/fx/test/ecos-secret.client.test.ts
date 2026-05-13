// Unit tests for the ECOS API key resolver — Secrets Manager primary path, env-var fallback for local tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = sendMock;
  },
  GetSecretValueCommand: class {
    constructor(public readonly input: { SecretId: string }) {}
  },
}));

const importFresh = async () => {
  vi.resetModules();
  return import('../src/infrastructure/outbound/ecos/ecos-secret.client.js');
};

const SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:EcosCredentialSecret-abc';

describe('getEcosApiKey', () => {
  beforeEach(() => {
    sendMock.mockReset();
    delete process.env.ECOS_CREDENTIAL_SECRET_ARN;
    delete process.env.ECOS_API_KEY;
  });

  afterEach(() => {
    delete process.env.ECOS_CREDENTIAL_SECRET_ARN;
    delete process.env.ECOS_API_KEY;
  });

  it('should return the apiKey from Secrets Manager when ECOS_CREDENTIAL_SECRET_ARN is set', async () => {
    process.env.ECOS_CREDENTIAL_SECRET_ARN = SECRET_ARN;
    sendMock.mockResolvedValueOnce({ SecretString: JSON.stringify({ apiKey: 'live-key-xyz' }) });
    const { getEcosApiKey } = await importFresh();

    const result = await getEcosApiKey();

    expect(result).toBe('live-key-xyz');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('should cache the apiKey across calls when Secrets Manager resolves successfully', async () => {
    process.env.ECOS_CREDENTIAL_SECRET_ARN = SECRET_ARN;
    sendMock.mockResolvedValueOnce({ SecretString: JSON.stringify({ apiKey: 'cached-key' }) });
    const { getEcosApiKey } = await importFresh();

    await getEcosApiKey();
    const second = await getEcosApiKey();

    expect(second).toBe('cached-key');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('should fall back to ECOS_API_KEY env when ECOS_CREDENTIAL_SECRET_ARN is unset', async () => {
    process.env.ECOS_API_KEY = 'env-fallback-key';
    const { getEcosApiKey } = await importFresh();

    const result = await getEcosApiKey();

    expect(result).toBe('env-fallback-key');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('should throw a 500 AppError when both ECOS_CREDENTIAL_SECRET_ARN and ECOS_API_KEY are missing', async () => {
    const { getEcosApiKey } = await importFresh();

    await expect(getEcosApiKey()).rejects.toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
  });

  it('should throw a 500 AppError when the Secrets Manager payload lacks an apiKey field', async () => {
    process.env.ECOS_CREDENTIAL_SECRET_ARN = SECRET_ARN;
    sendMock.mockResolvedValueOnce({ SecretString: JSON.stringify({ other: 'value' }) });
    const { getEcosApiKey } = await importFresh();

    await expect(getEcosApiKey()).rejects.toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
  });
});
