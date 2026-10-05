import { Module } from '@nestjs/common';
import { GrpcModule } from '../grpc/grpc.module';
import { StockReservationFailedHandler } from '../kafka/handlers/stock-reservation-failed.handler';
import { StockReservedHandler } from '../kafka/handlers/stock-reserved.handler';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderStateMachine } from './order-state-machine';

@Module({
  imports: [GrpcModule],
  controllers: [OrderController],
  providers: [OrderService, OrderStateMachine, StockReservedHandler, StockReservationFailedHandler],
  exports: [OrderStateMachine],
})
export class OrderModule {}
