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
import {
  FailedPreconditionError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../common/errors/domain-errors';
import {
  CreateOrderInputSchema,
  GetOrderInputSchema,
  ListMyOrdersInputSchema,
  ListAllOrdersInputSchema,
  CancelOrderInputSchema,
  ShipOrderInputSchema,
  DeliverOrderInputSchema,
  type CreateOrderInput,
  type ListMyOrdersInput,
} from './dto/order.dto';
import { toOutgoingMetadata, type Identity } from '../identity/identity.util';
import { OrderStateMachine, type LockedOrder, type TransitionTrigger } from './order-state-machine';

// `total_minor` / `unit_price_minor` are Postgres INTEGER (int32).
const INT32_MAX = 2_147_483_647;

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

  async createOrder(raw: unknown, identity: Identity): Promise<OrderWithItems> {
    const input = parse(CreateOrderInputSchema, raw, 'CreateOrder');
    const productIds = input.items.map((i) => i.productId);

    // The caller's identity is forwarded so user-service applies its ownership
    // check: another user's address id comes back NOT_FOUND.
    const [productsResponse, addressResponse] = await Promise.all([
      callGrpc(
        this.products.service.getProductsByIds({ productIds }, toOutgoingMetadata(identity)),
        this.timeouts.long,
        'product-service',
      ),
      callGrpc(
        this.users.service.getAddress({ addressId: input.addressId }, toOutgoingMetadata(identity)),
        this.timeouts.fast,
        'user-service',
      ),
    ]);

    const address = addressResponse.address;
    if (!address) {
      throw new NotFoundError('Address not found');
    }

    const snapshot = snapshotItems(input, productsResponse.products ?? []);

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          userId: identity.userId,
          totalMinor: snapshot.totalMinor,
          currency: snapshot.currency,
          shippingAddress: toShippingSnapshot(address),
          items: { create: snapshot.items },
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
        correlationId: identity.requestId,
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
    assertCanAccess(order, identity);
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

    return this.transitionOrder({
      orderId: input.orderId,
      identity,
      trigger: 'cancel',
      topic: TOPICS.ORDER_CANCELLED,
      buildPayload: (userId) => ({ orderId: input.orderId, userId, reason: input.reason }),
      reason: input.reason,
      adminOnly: false,
    });
  }

  async shipOrder(raw: unknown, identity: Identity): Promise<OrderWithItems> {
    const input = parse(ShipOrderInputSchema, raw, 'ShipOrder');

    return this.transitionOrder({
      orderId: input.orderId,
      identity,
      trigger: 'ship',
      topic: TOPICS.ORDER_SHIPPED,
      buildPayload: (userId) => ({ orderId: input.orderId, userId }),
      adminOnly: true,
    });
  }

  async deliverOrder(raw: unknown, identity: Identity): Promise<OrderWithItems> {
    const input = parse(DeliverOrderInputSchema, raw, 'DeliverOrder');

    return this.transitionOrder({
      orderId: input.orderId,
      identity,
      trigger: 'deliver',
      topic: TOPICS.ORDER_DELIVERED,
      buildPayload: (userId) => ({ orderId: input.orderId, userId }),
      adminOnly: true,
    });
  }

  private async transitionOrder<T extends TopicName>(args: {
    orderId: string;
    identity: Identity;
    trigger: TransitionTrigger;
    topic: T;
    buildPayload: (userId: string) => EventPayloadMap[T];
    reason?: string;
    adminOnly: boolean;
  }): Promise<OrderWithItems> {
    const { orderId, identity, adminOnly } = args;
    if (adminOnly && identity.role !== 'ADMIN') {
      throw new PermissionDeniedError('Admin role required');
    }

    return this.prisma.$transaction(async (tx) => {
      const { userId } = await this.stateMachine.transition(tx, orderId, args.trigger, {
        reason: args.reason,
        authorize: (order) => assertCanAccess(order, identity),
      });

      await this.outbox.enqueue(tx, {
        aggregateType: 'Order',
        aggregateId: orderId,
        topic: args.topic,
        payload: args.buildPayload(userId),
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
        // `id` tie-break keeps paging stable across equal timestamps.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return { orders, total, page, pageSize, totalPages };
  }
}

// Ownership is a NOT_FOUND, not PERMISSION_DENIED (same rule as user-service
// addresses): "exists but isn't yours" would let a probe enumerate order ids.
function assertCanAccess(order: Pick<LockedOrder, 'userId'>, identity: Identity): void {
  if (identity.role !== 'ADMIN' && order.userId !== identity.userId) {
    throw new NotFoundError('Order not found');
  }
}

interface ItemSnapshot {
  items: Prisma.OrderItemCreateWithoutOrderInput[];
  totalMinor: number;
  currency: string;
}

// Freezes name + price for every line from the product-service response. An
// order is single-currency: totals in minor units only add up within one.
function snapshotItems(input: CreateOrderInput, products: Product[]): ItemSnapshot {
  const byId = new Map(products.map((p) => [p.id, p]));
  const items: Prisma.OrderItemCreateWithoutOrderInput[] = [];
  let currency: string | undefined;
  let totalMinor = 0;

  for (const line of input.items) {
    const product = byId.get(line.productId);
    if (!product) {
      throw new NotFoundError(`Product not found: ${line.productId}`);
    }
    if (!product.isActive) {
      throw new FailedPreconditionError(`Product is not available: ${line.productId}`);
    }
    if (!product.price) {
      throw new FailedPreconditionError(`Product has no price: ${line.productId}`);
    }

    currency ??= product.price.currency;
    if (product.price.currency !== currency) {
      throw new FailedPreconditionError(
        `All items must share one currency (got ${currency} and ${product.price.currency})`,
      );
    }

    totalMinor += product.price.amountMinor * line.quantity;
    if (totalMinor > INT32_MAX) {
      throw new ValidationError('Order total exceeds the maximum allowed amount');
    }

    items.push({
      productId: line.productId,
      productName: product.name,
      unitPriceMinor: product.price.amountMinor,
      quantity: line.quantity,
    });
  }

  // `currency` is set: the schema guarantees at least one item.
  return { items, totalMinor, currency: currency! };
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
