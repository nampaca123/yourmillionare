// Unit tests for the EnsureUserExistsUseCase.

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { EnsureUserExistsUseCase } from '../src/application/ensure-user-exists.use-case.js';
import { InMemoryUserRepository } from './fakes/in-memory-user.repository.js';

describe('EnsureUserExistsUseCase', () => {
  let useCase: EnsureUserExistsUseCase;
  let users: InMemoryUserRepository;

  beforeEach(() => {
    users = new InMemoryUserRepository();
    useCase = new EnsureUserExistsUseCase(users);
  });

  it('should insert and return a new user when the cognitoSub does not exist', async () => {
    const input = { cognitoSub: randomUUID(), email: 'new@example.com' };

    const user = await useCase.execute(input);

    expect(user.cognitoSub).toBe(input.cognitoSub);
    expect(user.email).toBe(input.email);
    expect(user.id).toBeTruthy();
    expect(users.all()).toHaveLength(1);
  });

  it('should return the existing user without inserting when the cognitoSub is already registered', async () => {
    const sub = randomUUID();
    await useCase.execute({ cognitoSub: sub, email: 'first@example.com' });

    const user = await useCase.execute({ cognitoSub: sub, email: 'second@example.com' });

    expect(user.email).toBe('first@example.com');
    expect(users.all()).toHaveLength(1);
  });

  it('should update email when called again with a different email for the same cognitoSub', async () => {
    const sub = randomUUID();
    await users.upsert({ cognitoSub: sub, email: 'old@example.com' });

    const user = await users.upsert({ cognitoSub: sub, email: 'new@example.com' });

    expect(user.email).toBe('new@example.com');
  });
});
