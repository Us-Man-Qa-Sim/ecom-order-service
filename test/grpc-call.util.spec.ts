import { status as GrpcStatus } from '@grpc/grpc-js';
import { NEVER, of, throwError } from 'rxjs';
import { callGrpc, translateGrpcError } from '../src/grpc/grpc-call.util';
import {
  FailedPreconditionError,
  NotFoundError,
  UnavailableError,
  ValidationError,
} from '../src/common/errors/domain-errors';
import { toOutgoingMetadata } from '../src/identity/identity.util';

// Shape of a grpc-js ServiceError as Nest's ClientGrpcProxy surfaces it.
function grpcError(code: number, details: string) {
  return Object.assign(new Error(`${code} ${details}`), { code, details });
}

describe('callGrpc', () => {
  it('resolves with the first emitted value', async () => {
    await expect(callGrpc(of({ ok: true }), 1000)).resolves.toEqual({ ok: true });
  });

  it('turns a deadline into UnavailableError naming the upstream', async () => {
    await expect(callGrpc(NEVER, 10, 'user-service')).rejects.toThrow(
      new UnavailableError('user-service timed out'),
    );
  });

  it('translates downstream gRPC errors', async () => {
    const obs = throwError(() => grpcError(GrpcStatus.NOT_FOUND, 'Address not found'));
    await expect(callGrpc(obs, 1000)).rejects.toThrow(new NotFoundError('Address not found'));
  });
});

describe('translateGrpcError', () => {
  it.each([
    [GrpcStatus.INVALID_ARGUMENT, ValidationError],
    [GrpcStatus.NOT_FOUND, NotFoundError],
    [GrpcStatus.FAILED_PRECONDITION, FailedPreconditionError],
  ])('maps code %p to a domain error carrying the downstream details', (code, Expected) => {
    const mapped = translateGrpcError(grpcError(code, 'downstream says no'), 'svc');
    expect(mapped).toBeInstanceOf(Expected);
    expect((mapped as Error).message).toBe('downstream says no');
  });

  it.each([GrpcStatus.UNAVAILABLE, GrpcStatus.DEADLINE_EXCEEDED])(
    'maps code %p to UnavailableError without leaking details',
    (code) => {
      const mapped = translateGrpcError(
        grpcError(
          code,
          'No connection established. Last error: connect ECONNREFUSED 10.0.0.7:5002',
        ),
        'product-service',
      );
      expect(mapped).toEqual(new UnavailableError('product-service unavailable'));
    },
  );

  it.each([GrpcStatus.UNAUTHENTICATED, GrpcStatus.PERMISSION_DENIED, GrpcStatus.INTERNAL])(
    'leaves code %p untouched so the filter logs it and answers INTERNAL',
    (code) => {
      const err = grpcError(code, 'x');
      expect(translateGrpcError(err, 'svc')).toBe(err);
    },
  );

  it('leaves non-gRPC errors untouched', () => {
    const err = new TypeError('boom');
    expect(translateGrpcError(err, 'svc')).toBe(err);
  });
});

describe('toOutgoingMetadata', () => {
  it('forwards user id, role and request id', () => {
    const md = toOutgoingMetadata({ userId: 'u-1', role: 'ADMIN', requestId: 'req-9' });
    expect(md.get('x-user-id')).toEqual(['u-1']);
    expect(md.get('x-user-role')).toEqual(['ADMIN']);
    expect(md.get('x-request-id')).toEqual(['req-9']);
  });

  it('omits x-request-id when the caller had none', () => {
    const md = toOutgoingMetadata({ userId: 'u-1', role: 'CUSTOMER' });
    expect(md.get('x-request-id')).toEqual([]);
  });
});
