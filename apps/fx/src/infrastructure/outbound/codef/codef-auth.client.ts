// Client: fetches and caches the CODEF OAuth access token for the FX Lambda bundle.

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { AppError } from '@ym/shared-errors';

interface CodefSecret {
  clientId: string;
  clientSecret: string;
  publicKey?: string;
}

interface CodefTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

const CODEF_TOKEN_URL = 'https://oauth.codef.io/oauth/token';
const TOKEN_SAFETY_MARGIN_MS = 50_000;
const REGION = process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2';
const SECRET_ARN = process.env.CODEF_SECRET_ARN ?? '';

const smClient = new SecretsManagerClient({ region: REGION });

let cachedSecret: CodefSecret | undefined;
let cachedToken: string | undefined;
let tokenExpiresAt = 0;

const fetchSecret = async (): Promise<CodefSecret> => {
  if (cachedSecret) return cachedSecret;
  if (!SECRET_ARN) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.', 'CODEF_SECRET_ARN env var not set');
  }
  const result = await smClient.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  if (!result.SecretString) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.', 'CODEF secret missing SecretString');
  }
  cachedSecret = JSON.parse(result.SecretString) as CodefSecret;
  return cachedSecret;
};

const fetchToken = async (secret: CodefSecret): Promise<CodefTokenResponse> => {
  const credentials = Buffer.from(`${secret.clientId}:${secret.clientSecret}`).toString('base64');
  const response = await fetch(CODEF_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=read',
  });

  if (!response.ok) {
    throw new AppError(
      502,
      'CODEF_AUTH_ERROR',
      'External service error.',
      `CODEF OAuth failed: ${response.status} ${response.statusText}`,
    );
  }

  return response.json() as Promise<CodefTokenResponse>;
};

export const getCodefFxToken = async (): Promise<string> => {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const secret = await fetchSecret();
  const tokenResponse = await fetchToken(secret);

  cachedToken = tokenResponse.access_token;
  tokenExpiresAt = Date.now() + tokenResponse.expires_in * 1000 - TOKEN_SAFETY_MARGIN_MS;
  return cachedToken;
};
