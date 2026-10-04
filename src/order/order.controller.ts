import { Controller, UseFilters } from '@nestjs/common';
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
import { readIdentity, requireAdmin } from '../identity/identity.util';
import { OrderService } from './order.service';
import { toProtoOrder } from './order.mapper';

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
    const order = await this.orderService.createOrder(request, identity);
    return { order: toProtoOrder(order) };
  }

  async getOrder(request: GetOrderRequest, metadata?: Metadata): Promise<GetOrderResponse> {
    const identity = readIdentity(metadata);
    const order = await this.orderService.getOrder(request, identity);
    return { order: toProtoOrder(order) };
  }

  async listMyOrders(
    request: ListMyOrdersRequest,
    metadata?: Metadata,
  ): Promise<ListMyOrdersResponse> {
    const identity = readIdentity(metadata);
    const result = await this.orderService.listMyOrders(request, identity.userId);
    return {
      orders: result.orders.map(toProtoOrder),
      pagination: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
      },
    };
  }

  async listAllOrders(
    request: ListAllOrdersRequest,
    metadata?: Metadata,
  ): Promise<ListAllOrdersResponse> {
    const identity = readIdentity(metadata);
    requireAdmin(identity);
    const result = await this.orderService.listAllOrders(request);
    return {
      orders: result.orders.map(toProtoOrder),
      pagination: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
      },
    };
  }

  async cancelOrder(
    request: CancelOrderRequest,
    metadata?: Metadata,
  ): Promise<CancelOrderResponse> {
    const identity = readIdentity(metadata);
    const order = await this.orderService.cancelOrder(request, identity);
    return { order: toProtoOrder(order) };
  }

  async shipOrder(request: ShipOrderRequest, metadata?: Metadata): Promise<ShipOrderResponse> {
    const identity = readIdentity(metadata);
    requireAdmin(identity);
    const order = await this.orderService.shipOrder(request, identity);
    return { order: toProtoOrder(order) };
  }

  async deliverOrder(
    request: DeliverOrderRequest,
    metadata?: Metadata,
  ): Promise<DeliverOrderResponse> {
    const identity = readIdentity(metadata);
    requireAdmin(identity);
    const order = await this.orderService.deliverOrder(request, identity);
    return { order: toProtoOrder(order) };
  }
}
