import { Module } from '@nestjs/common';
import { GrpcModule } from '../grpc/grpc.module';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderStateMachine } from './order-state-machine';

@Module({
  imports: [GrpcModule],
  controllers: [OrderController],
  providers: [OrderService, OrderStateMachine],
  exports: [OrderStateMachine],
})
export class OrderModule {}
