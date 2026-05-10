// Port: bank-connection persistence operations (one row per tenant × bank).

export interface BankConnection {
  id: string;
  tenantId: string;
  organization: string;
  connectedId: string;
}

export interface BankConnectionRepository {
  upsert(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    organization: string;
    connectedId: string;
  }): Promise<BankConnection>;

  findByOrganization(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    organization: string;
  }): Promise<BankConnection | null>;
}
