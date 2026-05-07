// PostgreSQL UserRepository: upserts user by Cognito sub for journal Lambda context.

import type { PoolClient } from 'pg';
import type { UserRepository } from '../../../application/ports/user.repository.port.js';
import { withRlsContext } from './pg-rls.context.js';

interface UserRow {
  id: string;
}

export class PgUserRepository implements UserRepository {
  async findOrCreateByCognitoSub(cognitoSub: string, email: string): Promise<{ id: string }> {
    return withRlsContext({ cognitoSub }, async (c: PoolClient) => {
      const result = await c.query<UserRow>(
        `INSERT INTO users (cognito_sub, email)
         VALUES ($1, $2)
         ON CONFLICT (cognito_sub) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [cognitoSub, email],
      );
      const user = result.rows[0];
      if (!user) throw new Error('User upsert returned no row');
      await c.query("SELECT set_config('app.current_user_id', $1, true)", [user.id]);
      return { id: user.id };
    });
  }
}
