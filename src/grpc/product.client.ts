import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import {
  PRODUCT_SERVICE_NAME,
  type ProductServiceClient,
} from '@us-man-qa-sim/ecom-contracts/generated/product';
import { PRODUCT_GRPC_PACKAGE } from './grpc-tokens';

@Injectable()
export class ProductGrpcClient implements OnModuleInit {
  private client!: ProductServiceClient;

  constructor(@Inject(PRODUCT_GRPC_PACKAGE) private readonly grpc: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpc.getService<ProductServiceClient>(PRODUCT_SERVICE_NAME);
  }

  get service(): ProductServiceClient {
    return this.client;
  }
}
