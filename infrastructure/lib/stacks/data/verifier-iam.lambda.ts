// Verifier (IAM): rehearses Slice 3 connection pattern — pg + IAM token — from inside the VPC.

import { Signer } from '@aws-sdk/rds-signer';
import { Client } from 'pg';

interface CfnEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
}

interface VerifierOutput {
  check: 'iam-token';
  status: 'OK' | 'FAILED';
  iamConnectMs: number;
  errors: string[];
}

const CLUSTER_ENDPOINT = process.env.CLUSTER_ENDPOINT ?? '';
const CLUSTER_PORT = parseInt(process.env.CLUSTER_PORT ?? '5432', 10);
const DATABASE = process.env.DATABASE_NAME ?? 'yourmillionare';
const REGION = process.env.APP_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-2';
const PHYSICAL_ID = 'verifier-iam';

export const handler = async (event: CfnEvent): Promise<{ PhysicalResourceId: string }> => {
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? PHYSICAL_ID };
  }

  const errors: string[] = [];
  const start = Date.now();
  let client: Client | undefined;

  try {
    const signer = new Signer({
      hostname: CLUSTER_ENDPOINT,
      port: CLUSTER_PORT,
      username: 'app_user',
      region: REGION,
    });

    const token = await signer.getAuthToken();

    client = new Client({
      host: CLUSTER_ENDPOINT,
      port: CLUSTER_PORT,
      user: 'app_user',
      password: token,
      database: DATABASE,
      ssl: { rejectUnauthorized: false },
    });

    await client.connect();
    await client.query('SELECT 1');
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    await client?.end().catch(() => undefined);
  }

  const iamConnectMs = Date.now() - start;

  const output: VerifierOutput = {
    check: 'iam-token',
    status: errors.length === 0 ? 'OK' : 'FAILED',
    iamConnectMs,
    errors,
  };

  console.log(JSON.stringify(output));

  if (errors.length > 0) {
    throw new Error(`IAM token verification failed: ${errors.join('; ')}`);
  }

  return { PhysicalResourceId: PHYSICAL_ID };
};
