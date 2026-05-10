// Port: bank account persistence operations.

export interface BankAccount {
  id: string;
  tenantId: string;
  organization: string;
  accountNumber: string;
  connectedId: string;
  isActive: boolean;
  createdAt: Date;
}

export interface BankAccountRepository {
  insert(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    organization: string;
    accountNumber: string;
    connectedId: string;
  }): Promise<BankAccount>;
}
