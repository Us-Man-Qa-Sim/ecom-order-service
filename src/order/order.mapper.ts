import {
  Order as PrismaOrder,
  OrderItem as PrismaOrderItem,
  OrderStatus as PrismaOrderStatus,
} from '@prisma/client';
import {
  Order as ProtoOrder,
  OrderItem as ProtoOrderItem,
  OrderStatus as ProtoOrderStatus,
  ShippingAddress,
} from '@us-man-qa-sim/ecom-contracts/generated/order';

function dateToTimestamp(date: Date): { seconds: number; nanos: number } {
  const millis = date.getTime();
  return {
    seconds: Math.trunc(millis / 1000),
    nanos: (millis % 1000) * 1_000_000,
  };
}

const statusToProto: Record<PrismaOrderStatus, ProtoOrderStatus> = {
  PENDING: ProtoOrderStatus.ORDER_STATUS_PENDING,
  CONFIRMED: ProtoOrderStatus.ORDER_STATUS_CONFIRMED,
  SHIPPED: ProtoOrderStatus.ORDER_STATUS_SHIPPED,
  DELIVERED: ProtoOrderStatus.ORDER_STATUS_DELIVERED,
  CANCELLED: ProtoOrderStatus.ORDER_STATUS_CANCELLED,
};

type OrderWithItems = PrismaOrder & { items: PrismaOrderItem[] };

export function toProtoOrder(order: OrderWithItems): ProtoOrder {
  const address = order.shippingAddress as Record<string, unknown>;

  return {
    id: order.id,
    userId: order.userId,
    status: statusToProto[order.status],
    total: {
      amountMinor: order.totalMinor,
      currency: order.currency,
    },
    shippingAddress: {
      street: address.street as string,
      city: address.city as string,
      state: (address.state as string) ?? undefined,
      postalCode: address.postalCode as string,
      country: address.country as string,
    } satisfies ShippingAddress,
    items: order.items.map((item) => toProtoOrderItem(item, order.currency)),
    createdAt: dateToTimestamp(order.createdAt),
    updatedAt: dateToTimestamp(order.updatedAt),
  };
}

function toProtoOrderItem(item: PrismaOrderItem, currency: string): ProtoOrderItem {
  return {
    id: item.id,
    productId: item.productId,
    productName: item.productName,
    unitPrice: {
      amountMinor: item.unitPriceMinor,
      currency,
    },
    quantity: item.quantity,
  };
}
