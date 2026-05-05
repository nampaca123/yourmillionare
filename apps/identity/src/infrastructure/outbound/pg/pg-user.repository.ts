// PostgreSQL UserRepository: resolves user via cognitoSub with per-transaction GUC sequencing.

import type { PoolClient } from 'pg';
import type { User } from '../../../domain/user.entity.js';
import { createUser } from '../../../domain/user.entity.js';
import type { UserRepository } from '../../../application/ports/user.repository.port.js';
import { withRlsContext } from './pg-rls.context.js';

interface UserRow {
  id: string;
  cognito_sub: string;
  email: string;
  created_at: Date;
}

const toUser = (row: UserRow): User =>
  createUser({ id: row.id, cognitoSub: row.cognito_sub, email: row.email, createdAt: row.created_at });

export class PgUserRepository implements UserRepository {
  async findByCognitoSub(cognitoSub: string): Promise<User | undefined> {
    return withRlsContext({ cognitoSub }, async (c: PoolClient) => {
      const result = await c.query<UserRow>(
        'SELECT id, cognito_sub, email, created_at FROM users WHERE cognito_sub = $1',
        [cognitoSub],
      );
      return result.rows[0] ? toUser(result.rows[0]) : undefined;
    });
  }

  async upsert(params: { cognitoSub: string; email: string }): Promise<User> {
    return withRlsContext({ cognitoSub: params.cognitoSub }, async (c: PoolClient) => {
      // GUC sequence: cognito_sub is set by withRlsContext, enabling INSERT policy.
      const result = await c.query<UserRow>(
        `INSERT INTO users (cognito_sub, email)
         VALUES ($1, $2)
         ON CONFLICT (cognito_sub) DO UPDATE SET email = EXCLUDED.email
         RETURNING id, cognito_sub, email, created_at`,
        [params.cognitoSub, params.email],
      );
      const user = result.rows[0];
      if (!user) throw new Error('Upsert returned no row');

      // Promote GUC so downstream RLS policies using current_user_id work in same transaction.
      await c.query("SELECT set_config('app.current_user_id', $1, true)", [user.id]);

      return toUser(user);
    });
  }
}
