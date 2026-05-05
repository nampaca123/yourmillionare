// Port: user persistence operations.

import type { User } from '../../domain/user.entity.js';

export interface UserRepository {
  findByCognitoSub(cognitoSub: string): Promise<User | undefined>;
  upsert(params: { cognitoSub: string; email: string }): Promise<User>;
}
