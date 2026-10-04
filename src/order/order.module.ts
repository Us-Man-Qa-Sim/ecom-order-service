import { Module } from '@nestjs/common';
import { GrpcModule } from '../grpc/grpc.module';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

@Module({
  imports: [GrpcModule],
  controllers: [OrderController],
  providers: [OrderService],
})
export class OrderModule {}
