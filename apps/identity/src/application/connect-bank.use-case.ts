// Use case: authenticates with the bank via CODEF, persists the connectedId, and returns discovered accounts.

import { ForbiddenError } from '@ym/shared-errors';
import type { TenantMemberRepository } from './ports/tenant-member.repository.port.js';
import type { BankConnectionRepository } from './ports/bank-connection.repository.port.js';
import type { CodefAccountPort, DiscoveredAccount } from './ports/codef-account.port.js';

export interface ConnectBankResult {
  connectionId: string;
  accounts: DiscoveredAccount[];
}

export class ConnectBankUseCase {
  constructor(
    private readonly members: TenantMemberRepository,
    private readonly connections: BankConnectionRepository,
    private readonly codef: CodefAccountPort,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    organization: string;
    loginId: string;
    loginPassword: string;
    birthDate?: string;
  }): Promise<ConnectBankResult> {
    const member = await this.members.isMember({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    if (!member) throw new ForbiddenError('User is not a member of this tenant.');

    const { connectedId, accounts } = await this.codef.connect({
      organization: params.organization,
      loginId: params.loginId,
      loginPassword: params.loginPassword,
      ...(params.birthDate !== undefined ? { birthDate: params.birthDate } : {}),
    });

    const connection = await this.connections.upsert({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
      organization: params.organization,
      connectedId,
    });

    return { connectionId: connection.id, accounts };
  }
}
