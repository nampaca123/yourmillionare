// Fake CodefAccountPort for use-case unit tests.

import type {
  CodefAccountPort,
  DiscoveredAccount,
} from '../../src/application/ports/codef-account.port.js';

export class FakeCodefAccountPort implements CodefAccountPort {
  public failNext = false;
  public failError: Error = new Error('CODEF connect failed');
  public connectedId = 'conn-test-001';
  public accounts: DiscoveredAccount[] = [
    { accountNumber: '110-123-456789', accountName: 'My Checking', balance: '100000' },
  ];
  public lastCall: { organization: string; loginId: string; loginPassword: string; birthDate?: string } | undefined;

  async connect(params: {
    organization: string;
    loginId: string;
    loginPassword: string;
    birthDate?: string;
  }): Promise<{ connectedId: string; accounts: DiscoveredAccount[] }> {
    this.lastCall = { ...params };
    if (this.failNext) {
      this.failNext = false;
      throw this.failError;
    }
    return { connectedId: this.connectedId, accounts: this.accounts };
  }
}
