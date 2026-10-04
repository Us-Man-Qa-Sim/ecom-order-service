import { Metadata } from '@grpc/grpc-js';
import { OrderStatus as ProtoOrderStatus } from '@us-man-qa-sim/ecom-contracts/generated/order';
import { OrderController } from '../src/order/order.controller';
import {
  UnauthenticatedError,
  PermissionDeniedError,
  ValidationError,
} from '../src/common/errors/domain-errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeMetadata(headers: Record<string, string>): Metadata {
  const md = new Metadata();
  for (const [k, v] of Object.entries(headers)) md.set(k, v);
  return md;
}

const defaultHeaders = { 'x-user-id': 'u-1', 'x-user-role': 'CUSTOMER', 'x-request-id': 'req-1' };

function protoOrder() {
  return {
    id: 'o-1',
    userId: 'u-1',
    status: ProtoOrderStatus.ORDER_STATUS_PENDING,
    total: { amountMinor: 1000, currency: 'USD' },
    shippingAddress: { street: '1 Main', city: 'NY', postalCode: '10001', country: 'US' },
    items: [],
    createdAt: { seconds: 1700000000, nanos: 0 },
    updatedAt: { seconds: 1700000000, nanos: 0 },
  };
}

function mockOrderService(overrides: Record<string, jest.Mock> = {}) {
  return {
    createOrder: jest.fn(),
    getOrder: jest.fn(),
    listMyOrders: jest.fn().mockResolvedValue({ orders: [], total: 0, page: 1, pageSize: 20, totalPages: 1 }),
    listAllOrders: jest.fn().mockResolvedValue({ orders: [], total: 0, page: 1, pageSize: 20, totalPages: 1 }),
    cancelOrder: jest.fn(),
    shipOrder: jest.fn(),
    deliverOrder: jest.fn(),
    ...overrides,
  };
}

// A fake PrismaOrder that the service returns — the controller maps it via toProtoOrder.
function fakePrismaOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o-1',
    userId: 'u-1',
    status: 'PENDING',
    totalMinor: 1000,
    currency: 'USD',
    shippingAddress: { street: '1 Main', city: 'NY', state: null, postalCode: '10001', country: 'US' },
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    items: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('OrderController', () => {
  describe('createOrder', () => {
    it('passes userId from metadata and returns the mapped order', async () => {
      const svc = mockOrderService();
      svc.createOrder.mockResolvedValue(fakePrismaOrder());
      const ctrl = new OrderController(svc as any);

      const result = await ctrl.createOrder(
        { addressId: 'a-1', items: [{ productId: 'p-1', quantity: 2 }] },
        makeMetadata(defaultHeaders),
      );

      expect(svc.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u-1',
          addressId: 'a-1',
          items: [{ productId: 'p-1', quantity: 2 }],
          correlationId: 'req-1',
        }),
      );
      expect(result.order).toBeDefined();
      expect(result.order!.id).toBe('o-1');
    });

    it('throws UnauthenticatedError without identity metadata', async () => {
      const ctrl = new OrderController(mockOrderService() as any);

      await expect(
        ctrl.createOrder({ addressId: 'a-1', items: [] }, new Metadata()),
      ).rejects.toThrow(UnauthenticatedError);
    });

    it('throws ValidationError when addressId is missing', async () => {
      const ctrl = new OrderController(mockOrderService() as any);

      await expect(
        ctrl.createOrder(
          { addressId: '', items: [{ productId: 'p', quantity: 1 }] },
          makeMetadata(defaultHeaders),
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when items are empty', async () => {
      const ctrl = new OrderController(mockOrderService() as any);

      await expect(
        ctrl.createOrder(
          { addressId: 'a-1', items: [] },
          makeMetadata(defaultHeaders),
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('getOrder', () => {
    it('returns the mapped order', async () => {
      const svc = mockOrderService();
      svc.getOrder.mockResolvedValue(fakePrismaOrder());
      const ctrl = new OrderController(svc as any);

      const result = await ctrl.getOrder(
        { orderId: 'o-1' },
        makeMetadata(defaultHeaders),
      );

      expect(result.order).toBeDefined();
      expect(svc.getOrder).toHaveBeenCalledWith(
        { orderId: 'o-1' },
        expect.objectContaining({ userId: 'u-1', role: 'CUSTOMER' }),
      );
    });
  });

  describe('listMyOrders', () => {
    it('passes userId from metadata', async () => {
      const svc = mockOrderService();
      const ctrl = new OrderController(svc as any);

      await ctrl.listMyOrders({} as any, makeMetadata(defaultHeaders));

      expect(svc.listMyOrders).toHaveBeenCalledWith(
        expect.anything(),
        'u-1',
      );
    });
  });

  describe('listAllOrders', () => {
    it('throws PermissionDeniedError for non-admin', async () => {
      const ctrl = new OrderController(mockOrderService() as any);

      await expect(
        ctrl.listAllOrders({} as any, makeMetadata(defaultHeaders)),
      ).rejects.toThrow(PermissionDeniedError);
    });

    it('allows admin', async () => {
      const svc = mockOrderService();
      const ctrl = new OrderController(svc as any);

      await expect(
        ctrl.listAllOrders(
          {} as any,
          makeMetadata({ ...defaultHeaders, 'x-user-role': 'ADMIN' }),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('cancelOrder', () => {
    it('delegates to service with identity', async () => {
      const svc = mockOrderService();
      svc.cancelOrder.mockResolvedValue(fakePrismaOrder({ status: 'CANCELLED' }));
      const ctrl = new OrderController(svc as any);

      const result = await ctrl.cancelOrder(
        { orderId: 'o-1', reason: 'changed mind' },
        makeMetadata(defaultHeaders),
      );

      expect(svc.cancelOrder).toHaveBeenCalledWith(
        { orderId: 'o-1', reason: 'changed mind' },
        expect.objectContaining({ userId: 'u-1' }),
      );
      expect(result.order).toBeDefined();
    });
  });

  describe('shipOrder', () => {
    it('requires admin', async () => {
      const ctrl = new OrderController(mockOrderService() as any);

      await expect(
        ctrl.shipOrder({ orderId: 'o-1' }, makeMetadata(defaultHeaders)),
      ).rejects.toThrow(PermissionDeniedError);
    });

    it('admin can ship', async () => {
      const svc = mockOrderService();
      svc.shipOrder.mockResolvedValue(fakePrismaOrder({ status: 'SHIPPED' }));
      const ctrl = new OrderController(svc as any);

      const result = await ctrl.shipOrder(
        { orderId: 'o-1' },
        makeMetadata({ ...defaultHeaders, 'x-user-role': 'ADMIN' }),
      );

      expect(result.order).toBeDefined();
    });
  });

  describe('deliverOrder', () => {
    it('requires admin', async () => {
      const ctrl = new OrderController(mockOrderService() as any);

      await expect(
        ctrl.deliverOrder({ orderId: 'o-1' }, makeMetadata(defaultHeaders)),
      ).rejects.toThrow(PermissionDeniedError);
    });

    it('admin can deliver', async () => {
      const svc = mockOrderService();
      svc.deliverOrder.mockResolvedValue(fakePrismaOrder({ status: 'DELIVERED' }));
      const ctrl = new OrderController(svc as any);

      const result = await ctrl.deliverOrder(
        { orderId: 'o-1' },
        makeMetadata({ ...defaultHeaders, 'x-user-role': 'ADMIN' }),
      );

      expect(result.order).toBeDefined();
    });
  });
});
