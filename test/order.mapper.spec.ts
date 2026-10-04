import { OrderStatus as PrismaOrderStatus } from '@prisma/client';
import { OrderStatus as ProtoOrderStatus } from '@us-man-qa-sim/ecom-contracts/generated/order';
import { toProtoOrder } from '../src/order/order.mapper';

function makePrismaOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    userId: 'u-1',
    status: 'PENDING' as PrismaOrderStatus,
    totalMinor: 2500,
    currency: 'EUR',
    shippingAddress: {
      street: '10 Rue A',
      city: 'Paris',
      state: null,
      postalCode: '75001',
      country: 'FR',
    },
    createdAt: new Date('2026-06-15T12:00:00.123Z'),
    updatedAt: new Date('2026-06-15T12:30:00.456Z'),
    items: [
      {
        id: 'oi-1',
        orderId: 'ord-1',
        productId: 'p-1',
        productName: 'Widget',
        unitPriceMinor: 500,
        quantity: 5,
      },
    ],
    ...overrides,
  };
}

describe('toProtoOrder', () => {
  it('maps all scalar fields', () => {
    const proto = toProtoOrder(makePrismaOrder() as any);

    expect(proto.id).toBe('ord-1');
    expect(proto.userId).toBe('u-1');
  });

  it.each([
    ['PENDING', ProtoOrderStatus.ORDER_STATUS_PENDING],
    ['CONFIRMED', ProtoOrderStatus.ORDER_STATUS_CONFIRMED],
    ['SHIPPED', ProtoOrderStatus.ORDER_STATUS_SHIPPED],
    ['DELIVERED', ProtoOrderStatus.ORDER_STATUS_DELIVERED],
    ['CANCELLED', ProtoOrderStatus.ORDER_STATUS_CANCELLED],
  ] as [PrismaOrderStatus, ProtoOrderStatus][])('maps status %s → %i', (prisma, expected) => {
    const proto = toProtoOrder(makePrismaOrder({ status: prisma }) as any);
    expect(proto.status).toBe(expected);
  });

  it('maps total as Money', () => {
    const proto = toProtoOrder(makePrismaOrder() as any);
    expect(proto.total).toEqual({ amountMinor: 2500, currency: 'EUR' });
  });

  it('maps shipping address fields', () => {
    const proto = toProtoOrder(makePrismaOrder() as any);
    expect(proto.shippingAddress).toEqual({
      street: '10 Rue A',
      city: 'Paris',
      state: undefined,
      postalCode: '75001',
      country: 'FR',
    });
  });

  it('maps state when present', () => {
    const proto = toProtoOrder(
      makePrismaOrder({
        shippingAddress: {
          street: '1 Main',
          city: 'NY',
          state: 'NY',
          postalCode: '10001',
          country: 'US',
        },
      }) as any,
    );
    expect(proto.shippingAddress?.state).toBe('NY');
  });

  it('maps timestamps from Date to seconds/nanos', () => {
    const proto = toProtoOrder(makePrismaOrder() as any);

    expect(proto.createdAt).toEqual({
      seconds: Math.trunc(new Date('2026-06-15T12:00:00.123Z').getTime() / 1000),
      nanos: 123 * 1_000_000,
    });
    expect(proto.updatedAt).toEqual({
      seconds: Math.trunc(new Date('2026-06-15T12:30:00.456Z').getTime() / 1000),
      nanos: 456 * 1_000_000,
    });
  });

  it('maps order items with currency inherited from order', () => {
    const proto = toProtoOrder(makePrismaOrder() as any);

    expect(proto.items).toHaveLength(1);
    expect(proto.items[0]).toEqual({
      id: 'oi-1',
      productId: 'p-1',
      productName: 'Widget',
      unitPrice: { amountMinor: 500, currency: 'EUR' },
      quantity: 5,
    });
  });

  it('maps multiple items', () => {
    const order = makePrismaOrder({
      items: [
        {
          id: 'oi-1',
          orderId: 'ord-1',
          productId: 'p-1',
          productName: 'A',
          unitPriceMinor: 100,
          quantity: 1,
        },
        {
          id: 'oi-2',
          orderId: 'ord-1',
          productId: 'p-2',
          productName: 'B',
          unitPriceMinor: 200,
          quantity: 3,
        },
      ],
    });
    const proto = toProtoOrder(order as any);
    expect(proto.items).toHaveLength(2);
    expect(proto.items[1].productName).toBe('B');
    expect(proto.items[1].unitPrice).toEqual({ amountMinor: 200, currency: 'EUR' });
  });
});
