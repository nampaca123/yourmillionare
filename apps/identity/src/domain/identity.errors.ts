// Domain errors for the identity bounded context.

import { ConflictError, NotFoundError, ValidationError } from '../shared/errors/app-error.js';

export class UserAlreadyExistsError extends ConflictError {
  constructor(cognitoSub: string) {
    super(`User with cognitoSub ${cognitoSub} already exists`);
  }
}

export class TenantNotFoundError extends NotFoundError {
  constructor(tenantId: string) {
    super('Tenant', `Tenant ${tenantId} not found`);
  }
}

export class DuplicateBizRegNoError extends ConflictError {
  constructor() {
    super('A tenant with this business registration number already exists');
  }
}

export class InvalidBizRegNoError extends ValidationError {
  constructor(value: string) {
    super(`Invalid business registration number format: ${value}`);
  }
}
