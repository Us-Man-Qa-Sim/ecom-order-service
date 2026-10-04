import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, Observable, timeout } from 'rxjs';

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

export function callGrpc<T>(obs: Observable<T>, timeoutMs: number): Promise<T> {
  return firstValueFrom(obs.pipe(timeout({ each: timeoutMs })));
}

function readOr(config: ConfigService | undefined, key: string, fallback: number): number {
  if (!config) return fallback;
  const value = config.get<number>(key);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
