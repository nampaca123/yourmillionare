// Deterministic KMS HMAC for biz_reg_no deduplication. Uses a separate non-rotating key.
// A dedicated key ensures that encryption key rotation never changes the collision-check hash.

import { KMSClient, GenerateMacCommand } from '@aws-sdk/client-kms';
import type { BizRegNoHasher } from '../../../application/ports/biz-reg-no-hasher.port.js';

export class KmsBizRegNoHasher implements BizRegNoHasher {
  private readonly client: KMSClient;
  private readonly hmacKeyArn: string;

  constructor(hmacKeyArn: string, region?: string) {
    this.hmacKeyArn = hmacKeyArn;
    this.client = new KMSClient({ region: region ?? process.env.APP_REGION ?? 'ap-northeast-2' });
  }

  async hash(plaintext: string): Promise<Buffer> {
    const { Mac } = await this.client.send(
      new GenerateMacCommand({
        KeyId: this.hmacKeyArn,
        MacAlgorithm: 'HMAC_SHA_256',
        Message: Buffer.from(plaintext, 'utf8'),
      }),
    );
    if (!Mac) throw new Error('KMS GenerateMac returned empty MAC');
    return Buffer.from(Mac);
  }
}
