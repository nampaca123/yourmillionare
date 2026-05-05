// In-memory UserRepository for use-case unit tests.

import { randomUUID } from 'crypto';
import type { User } from '../../src/domain/user.entity.js';
import { createUser } from '../../src/domain/user.entity.js';
import type { UserRepository } from '../../src/application/ports/user.repository.port.js';

export class InMemoryUserRepository implements UserRepository {
  private readonly store = new Map<string, User>();

  async findByCognitoSub(cognitoSub: string): Promise<User | undefined> {
    return [...this.store.values()].find((u) => u.cognitoSub === cognitoSub);
  }

  async upsert(params: { cognitoSub: string; email: string }): Promise<User> {
    const existing = await this.findByCognitoSub(params.cognitoSub);
    if (existing) {
      const updated = createUser({ ...existing, email: params.email });
      this.store.set(existing.id, updated);
      return updated;
    }
    const user = createUser({ id: randomUUID(), cognitoSub: params.cognitoSub, email: params.email });
    this.store.set(user.id, user);
    return user;
  }

  all(): User[] {
    return [...this.store.values()];
  }

  seed(user: User): void {
    this.store.set(user.id, user);
  }
}
