import { Injectable } from '@nestjs/common';
import { Order as PrismaOrder, OrderItem as PrismaOrderItem, Prisma } from '@prisma/client';
import { TOPICS } from '@us-man-qa-sim/ecom-contracts/events';
import type { Product } from '@us-man-qa-sim/ecom-contracts/generated/product';
import type { Address } from '@us-man-qa-sim/ecom-contracts/generated/user';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { ProductGrpcClient } from '../grpc/product.client';
import { UserGrpcClient } from '../grpc/user.client';
import { callGrpc, GrpcCallTimeouts } from '../grpc/grpc-call.util';
import { NotFoundError, ValidationError } from '../common/errors/domain-errors';

export interface CreateOrderInput {
  userId: string;
  addressId: string;
  items: { productId: string; quantity: number }[];
  correlationId?: string;
}

type OrderWithItems = PrismaOrder & { items: PrismaOrderItem[] };

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly products: ProductGrpcClient,
    private readonly users: UserGrpcClient,
    private readonly timeouts: GrpcCallTimeouts,
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
