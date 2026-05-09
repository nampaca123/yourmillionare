// Client: fetches and caches CODEF OAuth access token.

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { AppError } from '@ym/shared-errors';
import type { CodefSecret, CodefTokenResponse } from './codef.types.js';

const CODEF_TOKEN_URL = 'https://oauth.codef.io/oauth/token';
const TOKEN_SAFETY_MARGIN_MS = 50_000;
const REGION = process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2';
const SECRET_ARN = process.env.CODEF_SECRET_ARN ?? '';

const smClient = new SecretsManagerClient({ region: REGION });

let cachedSecret: CodefSecret | undefined;
let cachedToken: string | undefined;
let tokenExpiresAt = 0;

const getSecret = async (): Promise<CodefSecret> => {
  if (cachedSecret) return cachedSecret;
  const result = await smClient.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  if (!result.SecretString) throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.', 'CODEF secret missing SecretString');
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
    throw new AppError(502, 'CODEF_AUTH_ERROR', 'External service error.', `CODEF OAuth failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<CodefTokenResponse>;
};

export const getAccessToken = async (): Promise<string> => {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const secret = await getSecret();
  const tokenResponse = await fetchToken(secret);

  cachedToken = tokenResponse.access_token;
  tokenExpiresAt = Date.now() + tokenResponse.expires_in * 1000 - TOKEN_SAFETY_MARGIN_MS;

  return cachedToken;
};

export const getCodefSecret = async (): Promise<CodefSecret> => getSecret();
