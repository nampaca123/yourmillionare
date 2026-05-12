// Shared Bedrock Runtime client factory reused by classifier + agent runner.

import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

const DEFAULT_TIMEOUT_MS = 120_000;

let cached: BedrockRuntimeClient | undefined;

export const getBedrockClient = (timeoutMs: number = DEFAULT_TIMEOUT_MS): BedrockRuntimeClient => {
  if (cached) return cached;
  cached = new BedrockRuntimeClient({
    requestHandler: { requestTimeout: timeoutMs } as Record<string, unknown>,
  });
  return cached;
};

export const DEFAULT_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'global.anthropic.claude-sonnet-4-6';
