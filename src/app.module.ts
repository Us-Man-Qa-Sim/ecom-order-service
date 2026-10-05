import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.validation';
import { CorrelationModule } from './correlation/correlation.module';
import { CorrelationService } from './correlation/correlation.service';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { OutboxModule } from './outbox/outbox.module';
import { KafkaModule } from './kafka/kafka.module';
import { OrderModule } from './order/order.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    CorrelationModule,
    LoggerModule.forRootAsync({
      inject: [CorrelationService],
      useFactory: (correlation: CorrelationService) => ({
        pinoHttp: {
          level: process.env.LOG_LEVEL ?? 'info',
          transport:
            process.env.NODE_ENV === 'production'
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true, colorize: true } },
          customProps: () => ({ service: 'order-service' }),
          mixin: () => {
            const correlationId = correlation.getCorrelationId();
            return correlationId ? { correlationId } : {};
          },
        },
      }),
    }),
    PrismaModule,
    OutboxModule,
    KafkaModule,
    HealthModule,
    OrderModule,
  ],
})
export class AppModule {}
