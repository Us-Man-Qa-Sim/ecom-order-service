import { Module } from '@nestjs/common';
import { GrpcModule } from '../grpc/grpc.module';
import { OrderController } from './order.controller';

@Module({
  imports: [GrpcModule],
  controllers: [OrderController],
})
export class OrderModule {}
