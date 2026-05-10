// Unit tests for ConnectBankUseCase.

import { describe, it, expect, beforeEach } from 'vitest';
import { ForbiddenError } from '@ym/shared-errors';
import { ConnectBankUseCase } from '../src/application/connect-bank.use-case.js';
import { InMemoryTenantMemberRepository } from './fakes/in-memory-tenant-member.repository.js';
import { InMemoryBankConnectionRepository } from './fakes/in-memory-bank-connection.repository.js';
import { FakeCodefAccountPort } from './fakes/fake-codef-account.port.js';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const COGNITO_SUB = 'sub-abc';

describe('ConnectBankUseCase', () => {
  let memberRepo: InMemoryTenantMemberRepository;
  let connectionRepo: InMemoryBankConnectionRepository;
  let codef: FakeCodefAccountPort;
  let useCase: ConnectBankUseCase;

  beforeEach(() => {
    memberRepo = new InMemoryTenantMemberRepository();
    connectionRepo = new InMemoryBankConnectionRepository();
    codef = new FakeCodefAccountPort();
    useCase = new ConnectBankUseCase(memberRepo, connectionRepo, codef);
  });

  it('should return discovered accounts and persist connectedId when user is a member', async () => {
    await memberRepo.add({ tenantId: TENANT_ID, userId: USER_ID, role: 'owner', cognitoSub: COGNITO_SUB });
    codef.connectedId = 'conn-XYZ';
    codef.accounts = [{ accountNumber: '110443478154', accountName: 'Checking', balance: '1000' }];

    const result = await useCase.execute({
      tenantId: TENANT_ID, userId: USER_ID, cognitoSub: COGNITO_SUB,
      organization: '0088', loginId: 'shinhan-id', loginPassword: 'shinhan-pw',
    });

    expect(result.connectionId).toBeTruthy();
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.accountNumber).toBe('110443478154');
    const stored = await connectionRepo.findByOrganization({
      tenantId: TENANT_ID, userId: USER_ID, cognitoSub: COGNITO_SUB, organization: '0088',
    });
    expect(stored?.connectedId).toBe('conn-XYZ');
  });

  it('should throw ForbiddenError when user is not a tenant member', async () => {
    const promise = useCase.execute({
      tenantId: TENANT_ID, userId: USER_ID, cognitoSub: COGNITO_SUB,
      organization: '0088', loginId: 'x', loginPassword: 'y',
    });

    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('should propagate CODEF errors when external connect fails', async () => {
    await memberRepo.add({ tenantId: TENANT_ID, userId: USER_ID, role: 'owner', cognitoSub: COGNITO_SUB });
    codef.failNext = true;

    const promise = useCase.execute({
      tenantId: TENANT_ID, userId: USER_ID, cognitoSub: COGNITO_SUB,
      organization: '0088', loginId: 'x', loginPassword: 'y',
    });

    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it('should overwrite connectedId on second connect for the same organization', async () => {
    await memberRepo.add({ tenantId: TENANT_ID, userId: USER_ID, role: 'owner', cognitoSub: COGNITO_SUB });
    codef.connectedId = 'conn-1';
    await useCase.execute({
      tenantId: TENANT_ID, userId: USER_ID, cognitoSub: COGNITO_SUB,
      organization: '0088', loginId: 'x', loginPassword: 'y',
    });
    codef.connectedId = 'conn-2';

    await useCase.execute({
      tenantId: TENANT_ID, userId: USER_ID, cognitoSub: COGNITO_SUB,
      organization: '0088', loginId: 'x', loginPassword: 'y',
    });

    const stored = await connectionRepo.findByOrganization({
      tenantId: TENANT_ID, userId: USER_ID, cognitoSub: COGNITO_SUB, organization: '0088',
    });
    expect(stored?.connectedId).toBe('conn-2');
  });
});
