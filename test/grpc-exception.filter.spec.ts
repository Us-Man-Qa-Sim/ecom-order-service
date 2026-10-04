import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Prisma } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { z, ZodError } from 'zod';
import { GrpcExceptionFilter } from '../src/common/errors/grpc-exception.filter';
import {
  ConflictError,
  FailedPreconditionError,
  NotFoundError,
  PermissionDeniedError,
  UnauthenticatedError,
  UnavailableError,
  ValidationError,
} from '../src/common/errors/domain-errors';

async function caught(filter: GrpcExceptionFilter, err: unknown): Promise<RpcException> {
  const observable = filter.catch(err, {} as never);
  try {
    await firstValueFrom(observable);
    throw new Error('expected throw');
  } catch (thrown) {
    if (thrown instanceof RpcException) return thrown;
    throw thrown;
  }
}

function code(ex: RpcException): number {
  return (ex.getError() as { code: number }).code;
}

function message(ex: RpcException): string {
  return (ex.getError() as { message: string }).message;
}

describe('GrpcExceptionFilter (Prisma)', () => {
  let filter: GrpcExceptionFilter;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new GrpcExceptionFilter();
    errorSpy = jest
      .spyOn((filter as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => errorSpy.mockRestore());

  it('passes RpcException through unchanged', async () => {
    const original = new RpcException({ code: GrpcStatus.ABORTED, message: 'retry' });
    const mapped = await caught(filter, original);
    expect(mapped).toBe(original);
  });

  it.each([
    [new ValidationError('bad input'), GrpcStatus.INVALID_ARGUMENT],
    [new NotFoundError('gone'), GrpcStatus.NOT_FOUND],
    [new ConflictError('dup'), GrpcStatus.ALREADY_EXISTS],
    [new PermissionDeniedError('nope'), GrpcStatus.PERMISSION_DENIED],
    [new UnauthenticatedError('who?'), GrpcStatus.UNAUTHENTICATED],
    [new FailedPreconditionError('wrong state'), GrpcStatus.FAILED_PRECONDITION],
    [new UnavailableError('product-service unavailable'), GrpcStatus.UNAVAILABLE],
  ])('maps %p to correct gRPC code', async (err, expected) => {
    const mapped = await caught(filter, err);
    expect(code(mapped)).toBe(expected);
    expect(message(mapped)).toBe(err.message);
  });

  it('maps ZodError to INVALID_ARGUMENT', async () => {
    let zodErr: ZodError;
    try {
      z.object({ name: z.string() }).parse({});
      throw new Error('expected zod throw');
    } catch (err) {
      zodErr = err as ZodError;
    }
    const mapped = await caught(filter, zodErr);
    expect(code(mapped)).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(message(mapped)).toMatch(/Validation failed/);
    expect(message(mapped)).toMatch(/name/);
  });

  describe('Prisma errors', () => {
    function prismaError(errorCode: string, meta?: Record<string, unknown>) {
      return new Prisma.PrismaClientKnownRequestError('prisma error', {
        code: errorCode,
        clientVersion: '0.0.0',
        meta,
      });
    }

    it('maps P2002 (unique constraint) to ALREADY_EXISTS', async () => {
      const mapped = await caught(filter, prismaError('P2002', { target: ['email'] }));
      expect(code(mapped)).toBe(GrpcStatus.ALREADY_EXISTS);
      expect(message(mapped)).toMatch(/email/);
    });

    it('maps P2025 (record not found) to NOT_FOUND', async () => {
      const mapped = await caught(filter, prismaError('P2025'));
      expect(code(mapped)).toBe(GrpcStatus.NOT_FOUND);
    });

    it('maps P2003 (foreign key) to FAILED_PRECONDITION', async () => {
      const mapped = await caught(filter, prismaError('P2003'));
      expect(code(mapped)).toBe(GrpcStatus.FAILED_PRECONDITION);
    });

    it('maps P2034 (concurrent modification) to ABORTED', async () => {
      const mapped = await caught(filter, prismaError('P2034'));
      expect(code(mapped)).toBe(GrpcStatus.ABORTED);
    });

    it('maps unknown Prisma error to INTERNAL', async () => {
      const mapped = await caught(filter, prismaError('P9999'));
      expect(code(mapped)).toBe(GrpcStatus.INTERNAL);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  it('maps unknown Error to INTERNAL and logs it', async () => {
    const mapped = await caught(filter, new Error('oops'));
    expect(code(mapped)).toBe(GrpcStatus.INTERNAL);
    expect(message(mapped)).toBe('Internal server error');
    expect(errorSpy).toHaveBeenCalled();
  });
});
