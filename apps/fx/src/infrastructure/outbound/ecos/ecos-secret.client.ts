// Resolves the ECOS API key from Secrets Manager with a module-level cache and env-var fallback for local tests.

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { AppError } from '@ym/shared-errors';

const REGION = process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2';
const SECRET_ARN_ENV = 'ECOS_CREDENTIAL_SECRET_ARN';
const API_KEY_ENV = 'ECOS_API_KEY';

interface EcosSecretShape {
  readonly apiKey: string;
}

const smClient = new SecretsManagerClient({ region: REGION });

let cachedApiKey: string | undefined;

const readFromSecretsManager = async (secretArn: string): Promise<string> => {
  const result = await smClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.', 'ECOS secret missing SecretString');
  }
  const parsed = JSON.parse(result.SecretString) as Partial<EcosSecretShape>;
  if (!parsed.apiKey || parsed.apiKey.length < 4) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.', 'ECOS secret payload missing apiKey');
  }
  return parsed.apiKey;
};

export const getEcosApiKey = async (): Promise<string> => {
  if (cachedApiKey) return cachedApiKey;

  const secretArn = process.env[SECRET_ARN_ENV];
  if (secretArn) {
    cachedApiKey = await readFromSecretsManager(secretArn);
    return cachedApiKey;
  }

  const envKey = process.env[API_KEY_ENV];
  if (envKey && envKey.length >= 4) {
    cachedApiKey = envKey;
    return cachedApiKey;
  }

  throw new AppError(
    500,
    'INTERNAL_ERROR',
    'Internal server error.',
    `Neither ${SECRET_ARN_ENV} nor ${API_KEY_ENV} is set with a valid value.`,
  );
};

export const resetEcosApiKeyCacheForTests = (): void => {
  cachedApiKey = undefined;
};
