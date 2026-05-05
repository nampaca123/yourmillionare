// KMS direct encrypt/decrypt for biz_reg_no (10 chars, well under 4KB KMS limit — no DEK needed).

import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import type { BizRegNoEncryptor } from '../../../application/ports/biz-reg-no-encryptor.port.js';

export class KmsBizRegNoEncryptor implements BizRegNoEncryptor {
  private readonly client: KMSClient;
  private readonly keyArn: string;

  constructor(keyArn: string, region?: string) {
    this.keyArn = keyArn;
    this.client = new KMSClient({ region: region ?? process.env.APP_REGION ?? 'ap-northeast-2' });
  }

  async encrypt(plaintext: string): Promise<Buffer> {
    const { CiphertextBlob } = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyArn,
        Plaintext: Buffer.from(plaintext, 'utf8'),
      }),
    );
    if (!CiphertextBlob) throw new Error('KMS Encrypt returned empty ciphertext');
    return Buffer.from(CiphertextBlob);
  }

  async decrypt(ciphertext: Buffer): Promise<string> {
    const { Plaintext } = await this.client.send(
      new DecryptCommand({
        KeyId: this.keyArn,
        CiphertextBlob: ciphertext,
      }),
    );
    if (!Plaintext) throw new Error('KMS Decrypt returned empty plaintext');
    return Buffer.from(Plaintext).toString('utf8');
  }
}
