// Unit tests for StartTenantSyncUseCase: ensures sync_run is created BEFORE SFN dispatch and that the runId is propagated.

import { describe, it, expect, beforeEach } from 'vitest';
import { StartTenantSyncUseCase } from '../src/application/start-tenant-sync.use-case.js';
import { VerifyTenantMembershipUseCase } from '../src/application/verify-tenant-membership.use-case.js';
import { ForbiddenError } from '@ym/shared-errors';
import { InMemoryTenantMemberRepository } from './fakes/in-memory-tenant-member.repository.js';
import { InMemorySyncRunRepository } from './fakes/in-memory-sync-run.repository.js';
import { FakeSyncDispatcher } from './fakes/fake-sync-dispatcher.js';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const COGNITO_SUB = 'cognito-sub-test';

describe('StartTenantSyncUseCase', () => {
  let useCase: StartTenantSyncUseCase;
  let memberRepo: InMemoryTenantMemberRepository;
  let syncRuns: InMemorySyncRunRepository;
  let dispatcher: FakeSyncDispatcher;

  beforeEach(() => {
    memberRepo = new InMemoryTenantMemberRepository();
    syncRuns = new InMemorySyncRunRepository();
    dispatcher = new FakeSyncDispatcher();
    const verify = new VerifyTenantMembershipUseCase(memberRepo);
    useCase = new StartTenantSyncUseCase(verify, dispatcher, syncRuns);
  });

  it('should create a sync_run row before dispatching to SFN when membership is valid', async () => {
    memberRepo.add(TENANT_ID, USER_ID);

    const result = await useCase.execute({
      tenantId: TENANT_ID,
      userId: USER_ID,
      cognitoSub: COGNITO_SUB,
    });

    expect(result.syncRunId).toBeDefined();
    expect(result.status).toBe('queued');
    expect(syncRuns.all()).toHaveLength(1);
    expect(syncRuns.all()[0]?.id).toBe(result.syncRunId);
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]?.syncRunId).toBe(result.syncRunId);
    expect(dispatcher.calls[0]?.tenantId).toBe(TENANT_ID);
  });

  it('should attach SFN execution ARN to the sync_run after dispatch succeeds', async () => {
    memberRepo.add(TENANT_ID, USER_ID);

    const result = await useCase.execute({
      tenantId: TENANT_ID,
      userId: USER_ID,
      cognitoSub: COGNITO_SUB,
    });

    const stored = syncRuns.all().find((r) => r.id === result.syncRunId);
    expect(stored?.sfnExecutionArn).toBe(result.executionArn);
    expect(result.executionArn).toMatch(/^arn:aws:states:/);
  });

  it('should propagate idempotency key to dispatcher', async () => {
    memberRepo.add(TENANT_ID, USER_ID);

    await useCase.execute({
      tenantId: TENANT_ID,
      userId: USER_ID,
      cognitoSub: COGNITO_SUB,
      idempotencyKey: 'idem-123',
    });

    expect(dispatcher.calls[0]?.idempotencyKey).toBe('idem-123');
  });

  it('should throw ForbiddenError and NOT create a sync_run when caller is not a tenant member', async () => {
    const promise = useCase.execute({
      tenantId: TENANT_ID,
      userId: USER_ID,
      cognitoSub: COGNITO_SUB,
    });

    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
    expect(syncRuns.all()).toHaveLength(0);
    expect(dispatcher.calls).toHaveLength(0);
  });
});
