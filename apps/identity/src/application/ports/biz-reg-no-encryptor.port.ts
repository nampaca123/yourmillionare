// Port: KMS-backed encryption for business registration numbers.

export interface BizRegNoEncryptor {
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<string>;
}
