import { randomUUID } from 'node:crypto';
import { of } from 'rxjs';
import { OrderStatus } from '@prisma/client';
import { TOPICS } from '@us-man-qa-sim/ecom-contracts/events';
import { OrderService, type CreateOrderInput } from '../src/order/order.service';
import { OrderStateMachine } from '../src/order/order-state-machine';
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../src/common/errors/domain-errors';
import type { Identity } from '../src/identity/identity.util';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const uuid = () => randomUUID();

function makePrismaOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    userId: 'user-1',
    status: 'PENDING' as OrderStatus,
    totalMinor: 2000,
    currency: 'USD',
    shippingAddress: { street: '1 Main', city: 'NY', state: null, postalCode: '10001', country: 'US' },
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    items: [
      {
        id: uuid(),
        orderId: 'placeholder',
        productId: 'prod-1',
        productName: 'Widget',
        unitPriceMinor: 1000,
        quantity: 2,
      },
    ],
    ...overrides,
  };
}

function makeProducts(ids: string[]) {
  return ids.map((id) => ({
    id,
    name: `Product-${id}`,
    price: { amountMinor: 1000, currency: 'USD' },
  }));
}

function makeAddress() {
  return {
    street: '1 Main',
    city: 'NY',
    state: 'NY',
    postalCode: '10001',
    country: 'US',
  };
}

const customerIdentity: Identity = { userId: 'user-1', role: 'CUSTOMER', requestId: 'req-1' };
const adminIdentity: Identity = { userId: 'admin-1', role: 'ADMIN', requestId: 'req-2' };
const otherUserIdentity: Identity = { userId: 'user-2', role: 'CUSTOMER', requestId: 'req-3' };

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------
function buildMocks() {
  const orderCreateResult = makePrismaOrder();

  const prisma = {
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    order: {
      create: jest.fn().mockResolvedValue(orderCreateResult),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue(orderCreateResult),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
    },
    orderStatusHistory: { create: jest.fn() },
    outbox: { create: jest.fn() },
  };

  const outbox = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };

  const products = {
    service: {
      getProductsByIds: jest.fn().mockReturnValue(
        of({ products: makeProducts(['prod-1']) }),
      ),
    },
  };

  const users = {
    service: {
      getAddress: jest.fn().mockReturnValue(of({ address: makeAddress() })),
    },
  };

  const timeouts = { fast: 2000, standard: 5000, long: 10000 };

  const stateMachine = new OrderStateMachine();
  jest.spyOn(stateMachine, 'transition').mockResolvedValue({
    fromStatus: 'PENDING',
    toStatus: 'CONFIRMED',
  });

  const service = new OrderService(
    prisma as any,
    outbox as any,
    products as any,
    users as any,
    timeouts as any,
    stateMachine,
  );

  return { service, prisma, outbox, products, users, stateMachine, orderCreateResult };
}

// ---------------------------------------------------------------------------
// createOrder
// ---------------------------------------------------------------------------
describe('OrderService', () => {
  describe('createOrder', () => {
    const validInput: CreateOrderInput = {
      userId: 'user-1',
      addressId: 'addr-1',
      items: [{ productId: 'prod-1', quantity: 2 }],
      correlationId: 'corr-1',
    };

    it('creates an order inside a transaction and enqueues an outbox event', async () => {
      const { service, prisma, outbox } = buildMocks();

      const result = await service.createOrder(validInput);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            currency: 'USD',
          }),
          include: { items: true },
        }),
      );
      expect(outbox.enqueue).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          aggregateType: 'Order',
          topic: TOPICS.ORDER_CREATED,
          correlationId: 'corr-1',
        }),
      );
      expect(result).toBeDefined();
    });

    it('fetches products and address in parallel', async () => {
      const { service, products, users } = buildMocks();

      await service.createOrder(validInput);

      expect(products.service.getProductsByIds).toHaveBeenCalledWith({
        productIds: ['prod-1'],
      });
      expect(users.service.getAddress).toHaveBeenCalledWith({
        addressId: 'addr-1',
      });
    });

    it('computes total from product prices', async () => {
      const { service, prisma, products } = buildMocks();
      products.service.getProductsByIds.mockReturnValue(
        of({
          products: [
            { id: 'p-a', name: 'A', price: { amountMinor: 500, currency: 'EUR' } },
            { id: 'p-b', name: 'B', price: { amountMinor: 300, currency: 'EUR' } },
          ],
        }),
      );

      await service.createOrder({
        userId: 'u',
        addressId: 'a',
        items: [
          { productId: 'p-a', quantity: 2 },
          { productId: 'p-b', quantity: 3 },
        ],
      });

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalMinor: 500 * 2 + 300 * 3,
            currency: 'EUR',
          }),
        }),
      );
    });

    it('throws ValidationError for empty items', async () => {
      const { service } = buildMocks();

      await expect(
        service.createOrder({ ...validInput, items: [] }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for quantity < 1', async () => {
      const { service } = buildMocks();

      await expect(
        service.createOrder({ ...validInput, items: [{ productId: 'prod-1', quantity: 0 }] }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for duplicate product ids', async () => {
      const { service } = buildMocks();

      await expect(
        service.createOrder({
          ...validInput,
          items: [
            { productId: 'prod-1', quantity: 1 },
            { productId: 'prod-1', quantity: 2 },
          ],
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError when a product does not exist', async () => {
      const { service, products } = buildMocks();
      products.service.getProductsByIds.mockReturnValue(of({ products: [] }));

      await expect(service.createOrder(validInput)).rejects.toThrow(NotFoundError);
    });

    it('throws NotFoundError when address is missing', async () => {
      const { service, users } = buildMocks();
      users.service.getAddress.mockReturnValue(of({ address: undefined }));

      await expect(service.createOrder(validInput)).rejects.toThrow(NotFoundError);
    });

    it('snapshots the shipping address in the order', async () => {
      const { service, prisma } = buildMocks();

      await service.createOrder(validInput);

      const createArg = prisma.order.create.mock.calls[0][0];
      expect(createArg.data.shippingAddress).toEqual(
        expect.objectContaining({
          street: '1 Main',
          city: 'NY',
          country: 'US',
        }),
      );
    });

    it('creates a PENDING status history entry', async () => {
      const { service, prisma } = buildMocks();

      await service.createOrder(validInput);

      const createArg = prisma.order.create.mock.calls[0][0];
      expect(createArg.data.statusHistory).toEqual({
        create: { toStatus: 'PENDING' },
      });
    });
  });

  // -------------------------------------------------------------------------
  // getOrder
  // -------------------------------------------------------------------------
  describe('getOrder', () => {
    it('returns the order for the owner', async () => {
      const { service, prisma } = buildMocks();
      const order = makePrismaOrder({ userId: 'user-1' });
      prisma.order.findUnique.mockResolvedValue(order);

      const result = await service.getOrder(
        { orderId: order.id },
        customerIdentity,
      );

      expect(result).toBe(order);
    });

    it('allows admin to view any order', async () => {
      const { service, prisma } = buildMocks();
      const order = makePrismaOrder({ userId: 'other-user' });
      prisma.order.findUnique.mockResolvedValue(order);

      const result = await service.getOrder({ orderId: order.id }, adminIdentity);

      expect(result).toBe(order);
    });

    it('throws NotFoundError when order does not exist', async () => {
      const { service, prisma } = buildMocks();
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.getOrder({ orderId: uuid() }, customerIdentity),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws PermissionDeniedError for non-owner', async () => {
      const { service, prisma } = buildMocks();
      const order = makePrismaOrder({ userId: 'user-1' });
      prisma.order.findUnique.mockResolvedValue(order);

      await expect(
        service.getOrder({ orderId: order.id }, otherUserIdentity),
      ).rejects.toThrow(PermissionDeniedError);
    });

    it('throws ValidationError for invalid orderId', async () => {
      const { service } = buildMocks();

      await expect(
        service.getOrder({ orderId: 'not-a-uuid' }, customerIdentity),
      ).rejects.toThrow(ValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // listMyOrders
  // -------------------------------------------------------------------------
  describe('listMyOrders', () => {
    it('returns paginated results filtered by userId', async () => {
      const { service, prisma } = buildMocks();
      const orders = [makePrismaOrder()];
      prisma.order.findMany.mockResolvedValue(orders);
      prisma.order.count.mockResolvedValue(1);

      const result = await service.listMyOrders({}, 'user-1');

      expect(prisma.order.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1' }),
        }),
      );
      expect(result.orders).toEqual(orders);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it('applies status filter when provided', async () => {
      const { service, prisma } = buildMocks();
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      // Proto enum value 2 = ORDER_STATUS_CONFIRMED → 'CONFIRMED'
      await service.listMyOrders({ status: 2 }, 'user-1');

      expect(prisma.order.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1', status: 'CONFIRMED' }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // listAllOrders
  // -------------------------------------------------------------------------
  describe('listAllOrders', () => {
    it('returns all orders without user filter', async () => {
      const { service, prisma } = buildMocks();
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      const result = await service.listAllOrders({});

      expect(prisma.order.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
      expect(result.totalPages).toBe(1);
    });

    it('filters by userId when provided', async () => {
      const { service, prisma } = buildMocks();
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.listAllOrders({ userId: 'user-1' });

      expect(prisma.order.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1' }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // cancelOrder
  // -------------------------------------------------------------------------
  describe('cancelOrder', () => {
    it('transitions PENDING → CANCELLED and enqueues outbox event', async () => {
      const { service, prisma, outbox, stateMachine } = buildMocks();
      const order = makePrismaOrder({ status: 'PENDING', userId: 'user-1' });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.findUniqueOrThrow.mockResolvedValue(order);

      await service.cancelOrder({ orderId: order.id, reason: 'changed mind' }, customerIdentity);

      expect(stateMachine.transition).toHaveBeenCalledWith(
        prisma,
        order.id,
        'cancel',
        'changed mind',
      );
      expect(outbox.enqueue).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          topic: TOPICS.ORDER_CANCELLED,
          payload: expect.objectContaining({ reason: 'changed mind' }),
        }),
      );
    });

    it('allows owner to cancel', async () => {
      const { service, prisma } = buildMocks();
      const order = makePrismaOrder({ userId: 'user-1' });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.findUniqueOrThrow.mockResolvedValue(order);

      await expect(
        service.cancelOrder({ orderId: order.id }, customerIdentity),
      ).resolves.toBeDefined();
    });

    it('allows admin to cancel any order', async () => {
      const { service, prisma } = buildMocks();
      const order = makePrismaOrder({ userId: 'other-user' });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.findUniqueOrThrow.mockResolvedValue(order);

      await expect(
        service.cancelOrder({ orderId: order.id }, adminIdentity),
      ).resolves.toBeDefined();
    });

    it('throws PermissionDeniedError for non-owner customer', async () => {
      const { service, prisma } = buildMocks();
      const order = makePrismaOrder({ userId: 'user-1' });
      prisma.order.findUnique.mockResolvedValue(order);

      await expect(
        service.cancelOrder({ orderId: order.id }, otherUserIdentity),
      ).rejects.toThrow(PermissionDeniedError);
    });

    it('throws NotFoundError when order does not exist', async () => {
      const { service, prisma } = buildMocks();
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(
        service.cancelOrder({ orderId: uuid() }, customerIdentity),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // shipOrder
  // -------------------------------------------------------------------------
  describe('shipOrder', () => {
    it('admin-only: transitions and enqueues outbox event', async () => {
      const { service, prisma, outbox, stateMachine } = buildMocks();
      const order = makePrismaOrder({ status: 'CONFIRMED', userId: 'user-1' });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.findUniqueOrThrow.mockResolvedValue(order);

      await service.shipOrder({ orderId: order.id }, adminIdentity);

      expect(stateMachine.transition).toHaveBeenCalledWith(
        prisma,
        order.id,
        'ship',
        undefined,
      );
      expect(outbox.enqueue).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ topic: TOPICS.ORDER_SHIPPED }),
      );
    });

    it('throws PermissionDeniedError for non-admin', async () => {
      const { service } = buildMocks();

      await expect(
        service.shipOrder({ orderId: uuid() }, customerIdentity),
      ).rejects.toThrow(PermissionDeniedError);
    });
  });

  // -------------------------------------------------------------------------
  // deliverOrder
  // -------------------------------------------------------------------------
  describe('deliverOrder', () => {
    it('admin-only: transitions SHIPPED → DELIVERED', async () => {
      const { service, prisma, outbox, stateMachine } = buildMocks();
      const order = makePrismaOrder({ status: 'SHIPPED', userId: 'user-1' });
      prisma.order.findUnique.mockResolvedValue(order);
      prisma.order.findUniqueOrThrow.mockResolvedValue(order);

      await service.deliverOrder({ orderId: order.id }, adminIdentity);

      expect(stateMachine.transition).toHaveBeenCalledWith(
        prisma,
        order.id,
        'deliver',
        undefined,
      );
      expect(outbox.enqueue).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ topic: TOPICS.ORDER_DELIVERED }),
      );
    });

    it('throws PermissionDeniedError for non-admin', async () => {
      const { service } = buildMocks();

      await expect(
        service.deliverOrder({ orderId: uuid() }, customerIdentity),
      ).rejects.toThrow(PermissionDeniedError);
    });
  });
});
