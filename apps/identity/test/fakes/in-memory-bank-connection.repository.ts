// In-memory BankConnectionRepository for use-case unit tests.

import { randomUUID } from 'crypto';
import type {
  BankConnection,
  BankConnectionRepository,
} from '../../src/application/ports/bank-connection.repository.port.js';

export class InMemoryBankConnectionRepository implements BankConnectionRepository {
  private readonly store: BankConnection[] = [];

  async upsert(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    organization: string;
    connectedId: string;
  }): Promise<BankConnection> {
    const existing = this.store.find(
      (c) => c.tenantId === params.tenantId && c.organization === params.organization,
    );
    if (existing) {
      existing.connectedId = params.connectedId;
      return existing;
    }
    const created: BankConnection = {
      id: randomUUID(),
      tenantId: params.tenantId,
      organization: params.organization,
      connectedId: params.connectedId,
    };
    this.store.push(created);
    return created;
  }

  async findByOrganization(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    organization: string;
  }): Promise<BankConnection | null> {
    return (
      this.store.find(
        (c) => c.tenantId === params.tenantId && c.organization === params.organization,
      ) ?? null
    );
  }
}
