// Port: deterministic HMAC for deduplication of business registration numbers.

export interface BizRegNoHasher {
  hash(plaintext: string): Promise<Buffer>;
}
