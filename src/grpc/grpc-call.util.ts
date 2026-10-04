import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { firstValueFrom, Observable, timeout, TimeoutError } from 'rxjs';
import {
  FailedPreconditionError,
  NotFoundError,
  UnavailableError,
  ValidationError,
} from '../common/errors/domain-errors';

export type GrpcCallTimeoutProfile = 'fast' | 'standard' | 'long';

export const DEFAULT_GRPC_TIMEOUT_MS: Record<GrpcCallTimeoutProfile, number> = {
  fast: 2_000,
  standard: 5_000,
  long: 10_000,
};

@Injectable()
export class GrpcCallTimeouts {
  readonly fast: number;
  readonly standard: number;
  readonly long: number;

  constructor(config?: ConfigService) {
    this.fast = readOr(config, 'GRPC_TIMEOUT_FAST_MS', DEFAULT_GRPC_TIMEOUT_MS.fast);
    this.standard = readOr(config, 'GRPC_TIMEOUT_STANDARD_MS', DEFAULT_GRPC_TIMEOUT_MS.standard);
    this.long = readOr(config, 'GRPC_TIMEOUT_LONG_MS', DEFAULT_GRPC_TIMEOUT_MS.long);
  }
}

// Awaits a single downstream unary call with a deadline. Downstream gRPC
// errors arrive as raw grpc-js `ServiceError`s, which `GrpcExceptionFilter`
// would scrub to INTERNAL — so the caller-meaningful codes are translated into
// domain errors here. `upstream` names the service in UNAVAILABLE messages.
export async function callGrpc<T>(
  obs: Observable<T>,
  timeoutMs: number,
  upstream = 'upstream service',
): Promise<T> {
  try {
    return await firstValueFrom(obs.pipe(timeout({ each: timeoutMs })));
  } catch (err) {
    throw translateGrpcError(err, upstream);
  }
}

export function translateGrpcError(err: unknown, upstream: string): unknown {
  if (err instanceof TimeoutError) {
    return new UnavailableError(`${upstream} timed out`);
  }
  if (!isServiceError(err)) return err;

  const details = err.details || err.message;
  switch (err.code) {
    case GrpcStatus.INVALID_ARGUMENT:
      return new ValidationError(details);
    case GrpcStatus.NOT_FOUND:
      return new NotFoundError(details);
    case GrpcStatus.FAILED_PRECONDITION:
      return new FailedPreconditionError(details);
    case GrpcStatus.UNAVAILABLE:
    case GrpcStatus.DEADLINE_EXCEEDED:
      // grpc-js puts internal host:port in UNAVAILABLE details — don't forward.
      return new UnavailableError(`${upstream} unavailable`);
    default:
      // UNAUTHENTICATED / PERMISSION_DENIED / INTERNAL from downstream are our
      // bug, not the caller's: let the filter log it and answer INTERNAL.
      return err;
  }
}

interface ServiceErrorLike {
  code: number;
  details?: string;
  message: string;
}

function isServiceError(err: unknown): err is ServiceErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'number' &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}

function readOr(config: ConfigService | undefined, key: string, fallback: number): number {
  if (!config) return fallback;
  const value = config.get<number>(key);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
