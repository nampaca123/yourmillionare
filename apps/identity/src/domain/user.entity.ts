// User entity: maps 1:1 to Cognito sub; immutable after construction.

export interface User {
  readonly id: string;
  readonly cognitoSub: string;
  readonly email: string;
  readonly createdAt: Date;
}

export const createUser = (params: Omit<User, 'createdAt'> & { createdAt?: Date }): User => ({
  id: params.id,
  cognitoSub: params.cognitoSub,
  email: params.email,
  createdAt: params.createdAt ?? new Date(),
});
