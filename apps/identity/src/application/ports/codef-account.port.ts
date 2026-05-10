// Port: CODEF connection (connectedId issuance + account discovery).

export interface DiscoveredAccount {
  accountNumber: string;
  accountName: string;
  balance: string;
}

export interface CodefAccountPort {
  connect(params: {
    organization: string;
    loginId: string;
    loginPassword: string;
    birthDate?: string;
  }): Promise<{ connectedId: string; accounts: DiscoveredAccount[] }>;
}
