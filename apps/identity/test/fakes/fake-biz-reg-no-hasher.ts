// Fake BizRegNoHasher for unit tests — deterministic hash without KMS.

import { createHash } from 'crypto';
import type { BizRegNoHasher } from '../../src/application/ports/biz-reg-no-hasher.port.js';

export class FakeBizRegNoHasher implements BizRegNoHasher {
  async hash(plaintext: string): Promise<Buffer> {
    return Buffer.from(createHash('sha256').update(plaintext).digest());
  }
}
