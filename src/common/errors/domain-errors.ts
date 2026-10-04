export type DomainErrorKind =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PERMISSION_DENIED'
  | 'UNAUTHENTICATED'
  | 'FAILED_PRECONDITION';

export abstract class DomainError extends Error {
  abstract readonly kind: DomainErrorKind;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly kind = 'INVALID_ARGUMENT';
}

export class NotFoundError extends DomainError {
  readonly kind = 'NOT_FOUND';
}

export class ConflictError extends DomainError {
  readonly kind = 'ALREADY_EXISTS';
}

export class PermissionDeniedError extends DomainError {
  readonly kind = 'PERMISSION_DENIED';
}

export class UnauthenticatedError extends DomainError {
  readonly kind = 'UNAUTHENTICATED';
}

export class FailedPreconditionError extends DomainError {
  readonly kind = 'FAILED_PRECONDITION';
}
