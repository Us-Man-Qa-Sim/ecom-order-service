import { ArgumentsHost, Catch, Logger, RpcExceptionFilter } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { DomainError, DomainErrorKind } from './domain-errors';
import { throwError, Observable } from 'rxjs';

const kindToStatus: Record<DomainErrorKind, number> = {
  INVALID_ARGUMENT: GrpcStatus.INVALID_ARGUMENT,
  NOT_FOUND: GrpcStatus.NOT_FOUND,
  ALREADY_EXISTS: GrpcStatus.ALREADY_EXISTS,
  PERMISSION_DENIED: GrpcStatus.PERMISSION_DENIED,
  UNAUTHENTICATED: GrpcStatus.UNAUTHENTICATED,
  FAILED_PRECONDITION: GrpcStatus.FAILED_PRECONDITION,
  UNAVAILABLE: GrpcStatus.UNAVAILABLE,
};

@Catch()
export class GrpcExceptionFilter implements RpcExceptionFilter {
  private readonly logger = new Logger(GrpcExceptionFilter.name);

  catch(exception: unknown, _host: ArgumentsHost): Observable<never> {
    return throwError(() => this.toRpcException(exception));
  }

  private toRpcException(exception: unknown): RpcException {
    if (exception instanceof RpcException) {
      return exception;
    }
    if (exception instanceof DomainError) {
      return new RpcException({
        code: kindToStatus[exception.kind],
        message: exception.message,
      });
    }
    if (exception instanceof ZodError) {
      const message = exception.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      return new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: `Validation failed: ${message}`,
      });
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapPrisma(exception);
    }
    this.logger.error(
      { err: exception },
      'Unhandled exception in gRPC handler; returning INTERNAL',
    );
    return new RpcException({
      code: GrpcStatus.INTERNAL,
      message: 'Internal server error',
    });
  }

  private mapPrisma(err: Prisma.PrismaClientKnownRequestError): RpcException {
    switch (err.code) {
      case 'P2002': {
        const target = Array.isArray(err.meta?.target)
          ? (err.meta.target as string[]).join(', ')
          : (err.meta?.target ?? 'unique constraint');
        return new RpcException({
          code: GrpcStatus.ALREADY_EXISTS,
          message: `Value already exists for ${target}`,
        });
      }
      case 'P2025':
        return new RpcException({
          code: GrpcStatus.NOT_FOUND,
          message: 'Record not found',
        });
      case 'P2003':
        return new RpcException({
          code: GrpcStatus.FAILED_PRECONDITION,
          message: 'Foreign key constraint violated',
        });
      case 'P2034':
        return new RpcException({
          code: GrpcStatus.ABORTED,
          message: 'Concurrent modification; retry the request',
        });
      default:
        this.logger.error(
          { code: err.code, meta: err.meta },
          'Unmapped Prisma error; returning INTERNAL',
        );
        return new RpcException({
          code: GrpcStatus.INTERNAL,
          message: 'Internal server error',
        });
    }
  }
}
