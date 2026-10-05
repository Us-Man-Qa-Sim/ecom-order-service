import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CorrelationService } from './correlation.service';
import { CorrelationInterceptor } from './correlation.interceptor';

@Global()
@Module({
  providers: [CorrelationService, { provide: APP_INTERCEPTOR, useClass: CorrelationInterceptor }],
  exports: [CorrelationService],
})
export class CorrelationModule {}
