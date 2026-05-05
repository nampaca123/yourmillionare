// Fake BizRegNoEncryptor for unit tests — no KMS dependency.

import type { BizRegNoEncryptor } from '../../src/application/ports/biz-reg-no-encryptor.port.js';

export class FakeBizRegNoEncryptor implements BizRegNoEncryptor {
  async encrypt(plaintext: string): Promise<Buffer> {
    return Buffer.from(`enc:${plaintext}`, 'utf8');
  }

  async decrypt(ciphertext: Buffer): Promise<string> {
    return ciphertext.toString('utf8').replace(/^enc:/, '');
  }
}
