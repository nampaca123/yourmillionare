// Env config: validates CDK runtime environment once at synth time, throws on missing values.

import { z } from 'zod';

const DEFAULT_REGION = 'ap-northeast-2';
const DEFAULT_RERANK_REGION = 'ap-northeast-1';
const DEFAULT_RERANK_MODEL = 'cohere.rerank-v3-5:0';
const DEFAULT_EMBED_MODEL = 'amazon.titan-embed-text-v2:0';
const DEFAULT_RERANK_DAILY_LIMIT = '20';
const DEFAULT_ADMIN_GROUP = 'ym-tax-admin';
const DEFAULT_VPC_CIDR = '10.20.0.0/16';
const ACCOUNT_ID_PATTERN = /^\d{12}$/;

const envSchema = z.object({
  CDK_ENV: z.enum(['dev', 'prod']),
  AWS_REGION: z.string().min(1).default(DEFAULT_REGION),
  AWS_ACCOUNT_ID: z.string().regex(ACCOUNT_ID_PATTERN, {
    message: 'AWS_ACCOUNT_ID must be a 12-digit account number.',
  }),
  VPC_CIDR: z.string().default(DEFAULT_VPC_CIDR),
  BEDROCK_KB_REGION: z.string().min(1).default(DEFAULT_REGION),
  BEDROCK_RERANK_REGION: z.string().min(1).default(DEFAULT_RERANK_REGION),
  BEDROCK_RERANK_MODEL: z.string().min(1).default(DEFAULT_RERANK_MODEL),
  BEDROCK_EMBED_MODEL: z.string().min(1).default(DEFAULT_EMBED_MODEL),
  RERANK_DAILY_LIMIT_PER_USER: z.string().default(DEFAULT_RERANK_DAILY_LIMIT),
  ADMIN_COGNITO_GROUP: z.string().default(DEFAULT_ADMIN_GROUP),
  ADMIN_IP_ALLOWLIST: z.string().optional(),
  API_CORS_ALLOWED_ORIGINS: z.string().optional(),
});

export type DeploymentEnv = z.infer<typeof envSchema>['CDK_ENV'];

export interface EnvConfig {
  env: DeploymentEnv;
  region: string;
  account: string;
  stackPrefix: string;
  vpcCidr: string;
  isProd: boolean;
  bedrockKbRegion: string;
  bedrockRerankRegion: string;
  bedrockRerankModel: string;
  bedrockEmbedModel: string;
  rerankDailyLimitPerUser: number;
  adminCognitoGroup: string;
  adminIpAllowlist: ReadonlyArray<string>;
  apiCorsAllowedOrigins: ReadonlyArray<string>;
}

const splitCsv = (value: string | undefined): ReadonlyArray<string> =>
  value ? value.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : [];

export const loadEnvConfig = (): EnvConfig => {
  const parsed = envSchema.safeParse({
    CDK_ENV: process.env.CDK_ENV,
    AWS_REGION: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION,
    AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID ?? process.env.CDK_DEFAULT_ACCOUNT,
    VPC_CIDR: process.env.VPC_CIDR,
    BEDROCK_KB_REGION: process.env.BEDROCK_KB_REGION,
    BEDROCK_RERANK_REGION: process.env.BEDROCK_RERANK_REGION,
    BEDROCK_RERANK_MODEL: process.env.BEDROCK_RERANK_MODEL,
    BEDROCK_EMBED_MODEL: process.env.BEDROCK_EMBED_MODEL,
    RERANK_DAILY_LIMIT_PER_USER: process.env.RERANK_DAILY_LIMIT_PER_USER,
    ADMIN_COGNITO_GROUP: process.env.ADMIN_COGNITO_GROUP,
    ADMIN_IP_ALLOWLIST: process.env.ADMIN_IP_ALLOWLIST,
    API_CORS_ALLOWED_ORIGINS: process.env.API_CORS_ALLOWED_ORIGINS,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid CDK environment configuration. ${issues}`);
  }

  const isProd = parsed.data.CDK_ENV === 'prod';

  return {
    env: parsed.data.CDK_ENV,
    region: parsed.data.AWS_REGION,
    account: parsed.data.AWS_ACCOUNT_ID,
    stackPrefix: `Ym-${isProd ? 'Prod' : 'Dev'}`,
    vpcCidr: parsed.data.VPC_CIDR,
    isProd,
    bedrockKbRegion: parsed.data.BEDROCK_KB_REGION,
    bedrockRerankRegion: parsed.data.BEDROCK_RERANK_REGION,
    bedrockRerankModel: parsed.data.BEDROCK_RERANK_MODEL,
    bedrockEmbedModel: parsed.data.BEDROCK_EMBED_MODEL,
    rerankDailyLimitPerUser: Number.parseInt(parsed.data.RERANK_DAILY_LIMIT_PER_USER, 10),
    adminCognitoGroup: parsed.data.ADMIN_COGNITO_GROUP,
    adminIpAllowlist: splitCsv(parsed.data.ADMIN_IP_ALLOWLIST),
    apiCorsAllowedOrigins: splitCsv(parsed.data.API_CORS_ALLOWED_ORIGINS),
  };
};
