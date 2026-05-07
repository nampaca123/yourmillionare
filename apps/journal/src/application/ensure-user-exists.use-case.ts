// EnsureUserExistsUseCase: resolves internal userId from Cognito sub, creating the user if needed.

import type { UserRepository } from './ports/user.repository.port.js';

export class EnsureUserExistsUseCase {
  constructor(private readonly users: UserRepository) {}

  async execute(params: { cognitoSub: string; email: string }): Promise<{ id: string }> {
    return this.users.findOrCreateByCognitoSub(params.cognitoSub, params.email);
  }
}
