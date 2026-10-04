import type { Metadata } from '@grpc/grpc-js';
import { PermissionDeniedError, UnauthenticatedError } from '../common/errors/domain-errors';

export const ROLES = ['CUSTOMER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export interface Identity {
  userId: string;
  role: Role;
  requestId?: string;
}

const HEADER_USER_ID = 'x-user-id';
const HEADER_USER_ROLE = 'x-user-role';
const HEADER_REQUEST_ID = 'x-request-id';

function firstValue(metadata: Metadata | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  const values = metadata.get(key);
  if (!values || values.length === 0) return undefined;
  const raw = values[0];
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}

export function readIdentity(metadata: Metadata | undefined): Identity {
  const userId = firstValue(metadata, HEADER_USER_ID);
  const roleRaw = firstValue(metadata, HEADER_USER_ROLE);

  if (!userId || !roleRaw) {
    throw new UnauthenticatedError('Missing identity metadata');
  }

  const role = normaliseRole(roleRaw);
  if (!role) {
    throw new UnauthenticatedError(`Unknown role: ${roleRaw}`);
  }

  return {
    userId,
    role,
    requestId: firstValue(metadata, HEADER_REQUEST_ID),
  };
}

export function readRequestId(metadata: Metadata | undefined): string | undefined {
  return firstValue(metadata, HEADER_REQUEST_ID);
}

function normaliseRole(value: string): Role | undefined {
  const upper = value.trim().toUpperCase();
  if (upper === 'CUSTOMER' || upper === 'ROLE_CUSTOMER') return 'CUSTOMER';
  if (upper === 'ADMIN' || upper === 'ROLE_ADMIN') return 'ADMIN';
  return undefined;
}

export function requireAdmin(identity: Identity): void {
  if (identity.role !== 'ADMIN') {
    throw new PermissionDeniedError('Admin role required');
  }
}
