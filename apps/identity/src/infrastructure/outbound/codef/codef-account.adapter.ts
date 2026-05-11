// Adapter: implements CodefAccountPort using CODEF OAuth + RSA-encrypted credentials.

import type { CodefAccountPort, DiscoveredAccount } from '../../../application/ports/codef-account.port.js';
import { encryptWithCodefKey } from './codef-rsa.js';
import { getCodefIdentityToken, getCodefIdentitySecret } from './codef-identity-auth.client.js';
import { createCodefAccount, listShinhanAccounts } from './codef-account.client.js';

export class CodefAccountAdapter implements CodefAccountPort {
  async connect(params: {
    organization: string;
    loginId: string;
    loginPassword: string;
    birthDate?: string;
  }): Promise<{ connectedId: string; accounts: DiscoveredAccount[] }> {
    const [token, secret] = await Promise.all([getCodefIdentityToken(), getCodefIdentitySecret()]);

    // Encrypt immediately and let plaintext go out of scope.
    const encryptedPassword = encryptWithCodefKey(secret.publicKey, params.loginPassword);

    const connectedId = await createCodefAccount({
      token,
      organization: params.organization,
      loginId: params.loginId,
      encryptedPassword,
      ...(params.birthDate !== undefined ? { birthDate: params.birthDate } : {}),
    });

    const accounts = await listShinhanAccounts(token, connectedId, params.organization);
    return { connectedId, accounts };
  }
}
