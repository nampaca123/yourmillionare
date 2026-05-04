// Env config: validates CDK runtime environment once at synth time, throws on missing values.

import { z } from 'zod';

const DEFAULT_REGION = 'ap-northeast-2';
const DEFAULT_VPC_CIDR = '10.20.0.0/16';
const ACCOUNT_ID_PATTERN = /^\d{12}$/;

const envSchema = z.object({
  CDK_ENV: z.enum(['dev', 'prod']),
  AWS_REGION: z.string().min(1).default(DEFAULT_REGION),
  AWS_ACCOUNT_ID: z.string().regex(ACCOUNT_ID_PATTERN, {
    message: 'AWS_ACCOUNT_ID must be a 12-digit account number.',
  }),
  VPC_CIDR: z.string().default(DEFAULT_VPC_CIDR),
});

export type DeploymentEnv = z.infer<typeof envSchema>['CDK_ENV'];

export interface EnvConfig {
  env: DeploymentEnv;
  region: string;
  account: string;
  stackPrefix: string;
  vpcCidr: string;
  isProd: boolean;
}

export const loadEnvConfig = (): EnvConfig => {
  const parsed = envSchema.safeParse({
    CDK_ENV: process.env.CDK_ENV,
    AWS_REGION: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION,
    AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID ?? process.env.CDK_DEFAULT_ACCOUNT,
    VPC_CIDR: process.env.VPC_CIDR,
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
  };
};
