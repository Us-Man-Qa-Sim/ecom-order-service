import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Logger as NestLogger, ShutdownSignal } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { GRPC_LOADER_OPTIONS, PROTO_FILES } from '@us-man-qa-sim/ecom-contracts';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));

  const grpcHost = process.env.GRPC_HOST ?? '0.0.0.0';
  const grpcPort = Number(process.env.GRPC_PORT ?? 5003);
  const httpHost = process.env.HTTP_HOST ?? '0.0.0.0';
  const httpPort = Number(process.env.HTTP_PORT ?? 8083);

  app.connectMicroservice<MicroserviceOptions>(
    {
      transport: Transport.GRPC,
      options: {
        url: `${grpcHost}:${grpcPort}`,
        package: ['ecom.order.v1'],
        protoPath: [PROTO_FILES.order, PROTO_FILES.common],
        loader: GRPC_LOADER_OPTIONS,
      },
    },
    { inheritAppConfig: true },
  );

  app.enableShutdownHooks([ShutdownSignal.SIGINT, ShutdownSignal.SIGTERM]);

  await app.startAllMicroservices();
  await app.listen(httpPort, httpHost);

  const logger = new NestLogger('bootstrap');
  logger.log(`gRPC listening on ${grpcHost}:${grpcPort}`);
  logger.log(`HTTP (health) listening on ${httpHost}:${httpPort}`);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
