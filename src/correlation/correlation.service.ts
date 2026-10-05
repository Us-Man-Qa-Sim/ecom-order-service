import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface CorrelationContext {
  correlationId: string;
}

@Injectable()
export class CorrelationService {
  private static readonly storage = new AsyncLocalStorage<CorrelationContext>();

  run<T>(context: CorrelationContext, callback: () => T): T {
    return CorrelationService.storage.run(context, callback);
  }

  getCorrelationId(): string | undefined {
    return CorrelationService.storage.getStore()?.correlationId;
  }
}
