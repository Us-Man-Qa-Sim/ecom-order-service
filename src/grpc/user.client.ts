import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import {
  USER_SERVICE_NAME,
  type UserServiceClient,
} from '@us-man-qa-sim/ecom-contracts/generated/user';
import { USER_GRPC_PACKAGE } from './grpc-tokens';

@Injectable()
export class UserGrpcClient implements OnModuleInit {
  private client!: UserServiceClient;

  constructor(@Inject(USER_GRPC_PACKAGE) private readonly grpc: ClientGrpc) {}

  onModuleInit(): void {
    this.client = this.grpc.getService<UserServiceClient>(USER_SERVICE_NAME);
  }

  get service(): UserServiceClient {
    return this.client;
  }
}
