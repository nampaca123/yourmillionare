// Use case: idempotent user provision — SELECT first, INSERT only when new.

import type { User } from '../domain/user.entity.js';
import type { UserRepository } from './ports/user.repository.port.js';

export interface EnsureUserExistsInput {
  cognitoSub: string;
  email: string;
}

export class EnsureUserExistsUseCase {
  constructor(private readonly users: UserRepository) {}

  async execute(input: EnsureUserExistsInput): Promise<User> {
    const existing = await this.users.findByCognitoSub(input.cognitoSub);
    if (existing) return existing;

    return this.users.upsert({ cognitoSub: input.cognitoSub, email: input.email });
  }
}
