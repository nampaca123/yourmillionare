// Domain errors for the identity bounded context.

import { AppError, ConflictError, NotFoundError, ValidationError } from '../shared/errors/app-error.js';

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

export class DuplicateBizRegNoError extends AppError {
  constructor() {
    super(409, 'BIZ_REG_NO_TAKEN', 'Business registration number is already registered.', 'Duplicate biz_reg_no on tenant creation');
  }
}

export class InvalidBizRegNoError extends ValidationError {
  constructor(value: string) {
    super(`Invalid business registration number format: ${value}`);
  }
}
