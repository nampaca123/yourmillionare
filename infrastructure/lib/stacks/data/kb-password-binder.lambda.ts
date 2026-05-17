// Custom Resource handler: reads the bedrock-kb-db-credentials secret and ALTER ROLE to apply the password to bedrock_kb_user.

import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda';

const REQUIRED_ENV = ['CLUSTER_ARN', 'MASTER_SECRET_ARN', 'KB_SECRET_ARN', 'DATABASE_NAME'] as const;
type EnvKey = typeof REQUIRED_ENV[number];

const readEnv = (): Record<EnvKey, string> => {
  const out = {} as Record<EnvKey, string>;
  for (const k of REQUIRED_ENV) {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env ${k}`);
    out[k] = v;
  }
  return out;
};

const rds = new RDSDataClient({});
const sm = new SecretsManagerClient({});

export const handler = async (event: CloudFormationCustomResourceEvent): Promise<CloudFormationCustomResourceResponse> => {
  const env = readEnv();
  const common = {
    PhysicalResourceId: event.LogicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
  };

  if (event.RequestType === 'Delete') {
    return { ...common, Status: 'SUCCESS' };
  }

  const kbSecretRaw = await sm.send(new GetSecretValueCommand({ SecretId: env.KB_SECRET_ARN }));
  const kbSecret = JSON.parse(kbSecretRaw.SecretString ?? '{}') as { password?: string };
  if (typeof kbSecret.password !== 'string' || kbSecret.password.length === 0) {
    throw new Error('KB secret missing password');
  }

  await rds.send(new ExecuteStatementCommand({
    resourceArn: env.CLUSTER_ARN,
    secretArn: env.MASTER_SECRET_ARN,
    database: env.DATABASE_NAME,
    sql: `ALTER ROLE bedrock_kb_user WITH PASSWORD '${kbSecret.password.replace(/'/g, "''")}'`,
  }));

  return { ...common, Status: 'SUCCESS' };
};
