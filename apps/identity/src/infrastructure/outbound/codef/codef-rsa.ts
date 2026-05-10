// Utility: RSA-PKCS1 encrypts a string using the CODEF-issued public key.

import { publicEncrypt, constants } from 'node:crypto';

export const encryptWithCodefKey = (publicKeyBase64: string, plaintext: string): string => {
  const pem = `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64}\n-----END PUBLIC KEY-----`;
  return publicEncrypt(
    { key: pem, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext),
  ).toString('base64');
};
