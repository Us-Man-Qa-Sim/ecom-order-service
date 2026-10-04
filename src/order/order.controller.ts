import { Controller, UseFilters } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import {
  CancelOrderRequest,
  CancelOrderResponse,
  CreateOrderRequest,
  CreateOrderResponse,
  DeliverOrderRequest,
  DeliverOrderResponse,
  GetOrderRequest,
  GetOrderResponse,
  ListAllOrdersRequest,
  ListAllOrdersResponse,
  ListMyOrdersRequest,
  ListMyOrdersResponse,
  OrderServiceController,
  OrderServiceControllerMethods,
  ShipOrderRequest,
  ShipOrderResponse,
} from '@us-man-qa-sim/ecom-contracts/generated/order';
import { GrpcExceptionFilter } from '../common/errors/grpc-exception.filter';
import { readIdentity } from '../identity/identity.util';
import { ValidationError } from '../common/errors/domain-errors';
import { OrderService } from './order.service';
import { toProtoOrder } from './order.mapper';

function unimplemented(rpc: string): never {
  throw new RpcException({ code: status.UNIMPLEMENTED, message: `${rpc} not implemented yet` });
}

@Controller()
@OrderServiceControllerMethods()
@UseFilters(GrpcExceptionFilter)
export class OrderController implements OrderServiceController {
  constructor(private readonly orderService: OrderService) {}

  async createOrder(
    request: CreateOrderRequest,
    metadata?: Metadata,
  ): Promise<CreateOrderResponse> {
    const identity = readIdentity(metadata);

    if (!request.addressId) {
      throw new ValidationError('address_id is required');
    }
    if (!request.items || request.items.length === 0) {
      throw new ValidationError('At least one item is required');
    }

    const order = await this.orderService.createOrder({
      userId: identity.userId,
      addressId: request.addressId,
      items: request.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
      })),
      correlationId: identity.requestId,
    });

    return { order: toProtoOrder(order) };
  }

  getOrder(_request: GetOrderRequest): Promise<GetOrderResponse> {
    unimplemented('GetOrder');
  }

  listMyOrders(_request: ListMyOrdersRequest): Promise<ListMyOrdersResponse> {
    unimplemented('ListMyOrders');
  }

  listAllOrders(_request: ListAllOrdersRequest): Promise<ListAllOrdersResponse> {
    unimplemented('ListAllOrders');
  }

  cancelOrder(_request: CancelOrderRequest): Promise<CancelOrderResponse> {
    unimplemented('CancelOrder');
  }

  shipOrder(_request: ShipOrderRequest): Promise<ShipOrderResponse> {
    unimplemented('ShipOrder');
  }

  deliverOrder(_request: DeliverOrderRequest): Promise<DeliverOrderResponse> {
    unimplemented('DeliverOrder');
  }
}
