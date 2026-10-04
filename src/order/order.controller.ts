import { Controller } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
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

function unimplemented(rpc: string): never {
  throw new RpcException({ code: status.UNIMPLEMENTED, message: `${rpc} not implemented yet` });
}

@Controller()
@OrderServiceControllerMethods()
export class OrderController implements OrderServiceController {
  createOrder(_request: CreateOrderRequest): Promise<CreateOrderResponse> {
    unimplemented('CreateOrder');
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
