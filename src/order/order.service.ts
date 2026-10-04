import { Injectable } from '@nestjs/common';
import { Order as PrismaOrder, OrderItem as PrismaOrderItem, Prisma } from '@prisma/client';
import { TOPICS, type EventPayloadMap, type TopicName } from '@us-man-qa-sim/ecom-contracts/events';
import type { Product } from '@us-man-qa-sim/ecom-contracts/generated/product';
import type { Address } from '@us-man-qa-sim/ecom-contracts/generated/user';
import type { ZodType } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { ProductGrpcClient } from '../grpc/product.client';
import { UserGrpcClient } from '../grpc/user.client';
import { callGrpc, GrpcCallTimeouts } from '../grpc/grpc-call.util';
import { NotFoundError, PermissionDeniedError, ValidationError } from '../common/errors/domain-errors';
import {
  GetOrderInputSchema,
  ListMyOrdersInputSchema,
  ListAllOrdersInputSchema,
  CancelOrderInputSchema,
  ShipOrderInputSchema,
  DeliverOrderInputSchema,
  type ListMyOrdersInput,
} from './dto/order.dto';
import type { Identity } from '../identity/identity.util';
import { OrderStateMachine, type TransitionTrigger } from './order-state-machine';

export interface CreateOrderInput {
  userId: string;
  addressId: string;
  items: { productId: string; quantity: number }[];
  correlationId?: string;
}

export type OrderWithItems = PrismaOrder & { items: PrismaOrderItem[] };

export interface PaginatedOrders {
  orders: OrderWithItems[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly products: ProductGrpcClient,
    private readonly users: UserGrpcClient,
    private readonly timeouts: GrpcCallTimeouts,
    private readonly stateMachine: OrderStateMachine,
  ) {}

  async createOrder(input: CreateOrderInput): Promise<OrderWithItems> {
    if (input.items.length === 0) {
      throw new ValidationError('Order must contain at least one item');
    }

    for (const item of input.items) {
      if (item.quantity < 1) {
        throw new ValidationError('Quantity must be at least 1');
      }
    }

    const uniqueProductIds = [...new Set(input.items.map((i) => i.productId))];
    if (uniqueProductIds.length !== input.items.length) {
      throw new ValidationError('Duplicate product ids in order items');
    }

    const [productsResponse, addressResponse] = await Promise.all([
      callGrpc(
        this.products.service.getProductsByIds({ productIds: uniqueProductIds }),
        this.timeouts.long,
      ),
      callGrpc(this.users.service.getAddress({ addressId: input.addressId }), this.timeouts.fast),
    ]);

    const productMap = new Map<string, Product>();
    for (const product of productsResponse.products) {
      productMap.set(product.id, product);
    }

    for (const id of uniqueProductIds) {
      if (!productMap.has(id)) {
        throw new NotFoundError(`Product not found: ${id}`);
      }
    }

    const address = addressResponse.address;
    if (!address) {
      throw new NotFoundError('Address not found');
    }

    const firstProduct = productMap.get(uniqueProductIds[0])!;
    const currency = firstProduct.price?.currency ?? 'USD';

    const orderItems: Prisma.OrderItemCreateWithoutOrderInput[] = [];
    let totalMinor = 0;

    for (const item of input.items) {
      const product = productMap.get(item.productId)!;
      const unitPriceMinor = product.price?.amountMinor ?? 0;
      totalMinor += unitPriceMinor * item.quantity;

      orderItems.push({
        productId: item.productId,
        productName: product.name,
        unitPriceMinor,
        quantity: item.quantity,
      });
    }

    const shippingSnapshot = toShippingSnapshot(address);

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          userId: input.userId,
          totalMinor,
          currency,
          shippingAddress: shippingSnapshot,
          items: { create: orderItems },
          statusHistory: {
            create: {
              toStatus: 'PENDING',
            },
          },
        },
        include: { items: true },
      });

      await this.outbox.enqueue(tx, {
        aggregateType: 'Order',
        aggregateId: order.id,
        topic: TOPICS.ORDER_CREATED,
        payload: {
          orderId: order.id,
          items: input.items.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
          })),
        },
        correlationId: input.correlationId,
      });

      return order;
    });
  }

  async getOrder(raw: unknown, identity: Identity): Promise<OrderWithItems> {
    const input = parse(GetOrderInputSchema, raw, 'GetOrder');
    const order = await this.prisma.order.findUnique({
      where: { id: input.orderId },
      include: { items: true },
    });
    if (!order) {
      throw new NotFoundError('Order not found');
    }
    if (identity.role !== 'ADMIN' && order.userId !== identity.userId) {
      throw new PermissionDeniedError('You do not own this order');
    }
    return order;
  }

  async listMyOrders(raw: unknown, userId: string): Promise<PaginatedOrders> {
    const input = parse(ListMyOrdersInputSchema, raw, 'ListMyOrders');
    return this.paginateOrders(input.pagination, { userId, status: input.status });
  }

  async listAllOrders(raw: unknown): Promise<PaginatedOrders> {
    const input = parse(ListAllOrdersInputSchema, raw, 'ListAllOrders');
    const where: Prisma.OrderWhereInput = {};
    if (input.status) where.status = input.status;
    if (input.userId) where.userId = input.userId;
    return this.paginateOrders(input.pagination, where);
  }

  async cancelOrder(raw: unknown, identity: Identity): Promise<OrderWithItems> {
    const input = parse(CancelOrderInputSchema, raw, 'CancelOrder');

    return this.transitionOrder(
      input.orderId,
      identity,
      'cancel',
      TOPICS.ORDER_CANCELLED,
      (userId) => ({ orderId: input.orderId, userId, reason: input.reason }),
      input.reason,
      false,
    );
  }

  async shipOrder(raw: unknown, identity: Identity): Promise<OrderWithItems> {
    const input = parse(ShipOrderInputSchema, raw, 'ShipOrder');

    return this.transitionOrder(
      input.orderId,
      identity,
      'ship',
      TOPICS.ORDER_SHIPPED,
      (userId) => ({ orderId: input.orderId, userId }),
      undefined,
      true,
    );
  }

  async deliverOrder(raw: unknown, identity: Identity): Promise<OrderWithItems> {
    const input = parse(DeliverOrderInputSchema, raw, 'DeliverOrder');

    return this.transitionOrder(
      input.orderId,
      identity,
      'deliver',
      TOPICS.ORDER_DELIVERED,
      (userId) => ({ orderId: input.orderId, userId }),
      undefined,
      true,
    );
  }

  private async transitionOrder<T extends TopicName>(
    orderId: string,
    identity: Identity,
    trigger: TransitionTrigger,
    topic: T,
    buildPayload: (userId: string) => EventPayloadMap[T],
    reason?: string,
    adminOnly?: boolean,
  ): Promise<OrderWithItems> {
    if (adminOnly) {
      if (identity.role !== 'ADMIN') {
        throw new PermissionDeniedError('Admin role required');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { userId: true },
      });

      if (!order) {
        throw new NotFoundError('Order not found');
      }

      if (!adminOnly && identity.role !== 'ADMIN' && order.userId !== identity.userId) {
        throw new PermissionDeniedError('You do not own this order');
      }

      await this.stateMachine.transition(tx, orderId, trigger, reason);

      await this.outbox.enqueue(tx, {
        aggregateType: 'Order',
        aggregateId: orderId,
        topic,
        payload: buildPayload(order.userId),
        correlationId: identity.requestId,
      });

      return tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true },
      });
    });
  }

  private async paginateOrders(
    pagination: ListMyOrdersInput['pagination'],
    where: Prisma.OrderWhereInput,
  ): Promise<PaginatedOrders> {
    const { page, pageSize } = pagination;
    const skip = (page - 1) * pageSize;

    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: { items: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return { orders, total, page, pageSize, totalPages };
  }
}

function parse<T>(schema: ZodType<T>, raw: unknown, rpc: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ValidationError(`Invalid ${rpc} request: ${message}`);
  }
  return parsed.data;
}

function toShippingSnapshot(address: Address): Prisma.InputJsonValue {
  return {
    street: address.street,
    city: address.city,
    state: address.state ?? null,
    postalCode: address.postalCode,
    country: address.country,
  };
}
