// UserRepository port: resolves internal userId from Cognito sub.

export interface UserRepository {
  findOrCreateByCognitoSub(cognitoSub: string, email: string): Promise<{ id: string }>;
}
