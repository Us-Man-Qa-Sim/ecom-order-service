import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { CorrelationService } from './correlation.service';

const HEADER_REQUEST_ID = 'x-request-id';

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  constructor(private readonly correlation: CorrelationService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') {
      return next.handle();
    }

    const metadata: Metadata | undefined = context.switchToRpc().getContext();
    const values = metadata?.get(HEADER_REQUEST_ID);
    const raw = values?.[0];
    const correlationId = typeof raw === 'string' ? raw : (raw?.toString('utf8') ?? randomUUID());

    return new Observable((subscriber) => {
      this.correlation.run({ correlationId }, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
