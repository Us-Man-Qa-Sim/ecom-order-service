import { randomUUID } from 'node:crypto';
import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { NEVER, of, throwError } from 'rxjs';
import { OrderStatus } from '@prisma/client';
import { TOPICS } from '@us-man-qa-sim/ecom-contracts/events';
import { OrderService } from '../src/order/order.service';
import { OrderStateMachine } from '../src/order/order-state-machine';
import {
  FailedPreconditionError,
  NotFoundError,
  PermissionDeniedError,
  UnavailableError,
  ValidationError,
} from '../src/common/errors/domain-errors';
import type { Identity } from '../src/identity/identity.util';
import { MAX_QUANTITY_PER_ITEM } from '../src/order/dto/order.dto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const uuid = () => randomUUID();

// Product ids are Mongo ObjectIds.
const PROD_1 = '64b000000000000000000001';
const PROD_2 = '64b000000000000000000002';
const ADDRESS_ID = '3f1c9f7e-2a5b-4c1e-9d0a-111111111111';

const USER_1 = uuid();
const USER_2 = uuid();
const ADMIN = uuid();

function makePrismaOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    userId: USER_1,
    status: 'PENDING' as OrderStatus,
    totalMinor: 2000,
    currency: 'USD',
    shippingAddress: {
      street: '1 Main',
      city: 'NY',
      state: null,
      postalCode: '10001',
      country: 'US',
    },
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    items: [
      {
        id: uuid(),
        orderId: 'placeholder',
        productId: PROD_1,
        productName: 'Widget',
        unitPriceMinor: 1000,
        quantity: 2,
      },
    ],
    ...overrides,
  };
}

function makeProduct(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Product-${id}`,
    price: { amountMinor: 1000, currency: 'USD' },
    isActive: true,
    ...overrides,
  };
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

function grpcError(code: number, details: string) {
  return Object.assign(new Error(`${code} ${details}`), { code, details });
}

const customerIdentity: Identity = { userId: USER_1, role: 'CUSTOMER', requestId: 'req-1' };
const adminIdentity: Identity = { userId: ADMIN, role: 'ADMIN', requestId: 'req-2' };
const otherUserIdentity: Identity = { userId: USER_2, role: 'CUSTOMER', requestId: 'req-3' };

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------
function buildMocks() {
  const orderCreateResult = makePrismaOrder();

  const prisma = {
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    // The state machine's locked read (`SELECT … FOR UPDATE`).
    $queryRaw: jest.fn().mockResolvedValue([]),
    order: {
      create: jest.fn().mockResolvedValue(orderCreateResult),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue(orderCreateResult),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({}),
    },
    orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  };

  const outbox = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  };

  const products = {
    service: {
      getProductsByIds: jest.fn().mockReturnValue(of({ products: [makeProduct(PROD_1)] })),
    },
  };

  const users = {
    service: {
      getAddress: jest.fn().mockReturnValue(of({ address: makeAddress() })),
    },
  };

  const timeouts = { fast: 2000, standard: 5000, long: 10000 };

  const stateMachine = new OrderStateMachine();
  jest.spyOn(stateMachine, 'transition');

  const service = new OrderService(
    prisma as never,
    outbox as never,
    products as never,
    users as never,
    timeouts as never,
    stateMachine,
  );

  // Seeds the row the state machine locks: snake_case, straight from SQL.
  const lockedOrder = (status: OrderStatus, userId = USER_1) =>
    prisma.$queryRaw.mockResolvedValue([{ user_id: userId, status }]);

  return {
    service,
    prisma,
    outbox,
    products,
    users,
    stateMachine,
    timeouts,
    lockedOrder,
    orderCreateResult,
  };
}

// ---------------------------------------------------------------------------
// createOrder
// ---------------------------------------------------------------------------
describe('OrderService', () => {
  describe('createOrder', () => {
    const validInput = {
      addressId: ADDRESS_ID,
      items: [{ productId: PROD_1, quantity: 2 }],
    };

    it('creates an order inside a transaction and enqueues an outbox event', async () => {
      const { service, prisma, outbox } = buildMocks();

      const result = await service.createOrder(validInput, customerIdentity);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: USER_1,
            totalMinor: 2000,
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
          correlationId: 'req-1',
          payload: expect.objectContaining({
            items: [{ productId: PROD_1, quantity: 2 }],
          }),
        }),
      );
      expect(result).toBeDefined();
    });

    it('forwards the caller identity to user-service and product-service', async () => {
      const { service, products, users } = buildMocks();

      await service.createOrder(validInput, customerIdentity);

      const [addressReq, addressMd] = users.service.getAddress.mock.calls[0] as [unknown, Metadata];
      expect(addressReq).toEqual({ addressId: ADDRESS_ID });
      expect(addressMd).toBeInstanceOf(Metadata);
      expect(addressMd.get('x-user-id')).toEqual([USER_1]);
      expect(addressMd.get('x-user-role')).toEqual(['CUSTOMER']);
      expect(addressMd.get('x-request-id')).toEqual(['req-1']);

      const [productsReq, productsMd] = products.service.getProductsByIds.mock.calls[0] as [
        unknown,
        Metadata,
      ];
      expect(productsReq).toEqual({ productIds: [PROD_1] });
      expect(productsMd.get('x-user-id')).toEqual([USER_1]);
    });

    it('computes total from product prices', async () => {
      const { service, prisma, products } = buildMocks();
      products.service.getProductsByIds.mockReturnValue(
        of({
          products: [
            makeProduct(PROD_1, { price: { amountMinor: 500, currency: 'EUR' } }),
            makeProduct(PROD_2, { price: { amountMinor: 300, currency: 'EUR' } }),
          ],
        }),
      );

      await service.createOrder(
        {
          addressId: ADDRESS_ID,
          items: [
            { productId: PROD_1, quantity: 2 },
            { productId: PROD_2, quantity: 3 },
          ],
        },
        customerIdentity,
      );

      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalMinor: 500 * 2 + 300 * 3,
            currency: 'EUR',
          }),
        }),
      );
    });

    it('snapshots name and unit price per line', async () => {
      const { service, prisma } = buildMocks();

      await service.createOrder(validInput, customerIdentity);

      const createArg = prisma.order.create.mock.calls[0][0];
      expect(createArg.data.items).toEqual({
        create: [
          {
            productId: PROD_1,
            productName: `Product-${PROD_1}`,
            unitPriceMinor: 1000,
            quantity: 2,
          },
        ],
      });
    });

    it.each([
      ['empty items', { ...validInput, items: [] }],
      ['quantity < 1', { ...validInput, items: [{ productId: PROD_1, quantity: 0 }] }],
      [
        'quantity over the per-line cap',
        { ...validInput, items: [{ productId: PROD_1, quantity: MAX_QUANTITY_PER_ITEM + 1 }] },
      ],
      ['non-integer quantity', { ...validInput, items: [{ productId: PROD_1, quantity: 1.5 }] }],
      [
        'duplicate product ids',
        {
          ...validInput,
          items: [
            { productId: PROD_1, quantity: 1 },
            { productId: PROD_1, quantity: 2 },
          ],
        },
      ],
      ['malformed product id', { ...validInput, items: [{ productId: 'prod-1', quantity: 1 }] }],
      ['missing address id', { ...validInput, addressId: '' }],
      ['non-uuid address id', { ...validInput, addressId: 'addr-1' }],
    ])('rejects %s with ValidationError before any downstream call', async (_label, input) => {
      const { service, products, users, prisma } = buildMocks();

      await expect(service.createOrder(input, customerIdentity)).rejects.toThrow(ValidationError);

      expect(products.service.getProductsByIds).not.toHaveBeenCalled();
      expect(users.service.getAddress).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when a product does not exist', async () => {
      const { service, products, prisma } = buildMocks();
      products.service.getProductsByIds.mockReturnValue(of({ products: [] }));

      await expect(service.createOrder(validInput, customerIdentity)).rejects.toThrow(
        NotFoundError,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws FailedPreconditionError for an inactive product', async () => {
      const { service, products } = buildMocks();
      products.service.getProductsByIds.mockReturnValue(
        of({ products: [makeProduct(PROD_1, { isActive: false })] }),
      );

      await expect(service.createOrder(validInput, customerIdentity)).rejects.toThrow(
        FailedPreconditionError,
      );
    });

    it('throws FailedPreconditionError for a product without a price', async () => {
      const { service, products } = buildMocks();
      // proto-loader decodes an unset message field as null (defaults: true).
      products.service.getProductsByIds.mockReturnValue(
        of({ products: [makeProduct(PROD_1, { price: null })] }),
      );

      await expect(service.createOrder(validInput, customerIdentity)).rejects.toThrow(
        FailedPreconditionError,
      );
    });

    it('throws FailedPreconditionError for mixed currencies', async () => {
      const { service, products, prisma } = buildMocks();
      products.service.getProductsByIds.mockReturnValue(
        of({
          products: [
            makeProduct(PROD_1, { price: { amountMinor: 100, currency: 'USD' } }),
            makeProduct(PROD_2, { price: { amountMinor: 100, currency: 'EUR' } }),
          ],
        }),
      );

      await expect(
        service.createOrder(
          {
            addressId: ADDRESS_ID,
            items: [
              { productId: PROD_1, quantity: 1 },
              { productId: PROD_2, quantity: 1 },
            ],
          },
          customerIdentity,
        ),
      ).rejects.toThrow(FailedPreconditionError);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws ValidationError when the total overflows int32', async () => {
      const { service, products } = buildMocks();
      products.service.getProductsByIds.mockReturnValue(
        of({
          products: [
            makeProduct(PROD_1, { price: { amountMinor: 2_000_000_000, currency: 'USD' } }),
          ],
        }),
      );

      await expect(
        service.createOrder(
          { addressId: ADDRESS_ID, items: [{ productId: PROD_1, quantity: 2 }] },
          customerIdentity,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError when the address is missing from the response', async () => {
      const { service, users } = buildMocks();
      users.service.getAddress.mockReturnValue(of({ address: null }));

      await expect(service.createOrder(validInput, customerIdentity)).rejects.toThrow(
        NotFoundError,
      );
    });

    it("maps user-service NOT_FOUND (e.g. another user's address) to NotFoundError", async () => {
      const { service, users, prisma } = buildMocks();
      users.service.getAddress.mockReturnValue(
        throwError(() => grpcError(GrpcStatus.NOT_FOUND, 'Address not found')),
      );

      await expect(service.createOrder(validInput, customerIdentity)).rejects.toThrow(
        new NotFoundError('Address not found'),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('maps an unreachable product-service to UnavailableError', async () => {
      const { service, products } = buildMocks();
      products.service.getProductsByIds.mockReturnValue(
        throwError(() => grpcError(GrpcStatus.UNAVAILABLE, 'No connection established')),
      );

      await expect(service.createOrder(validInput, customerIdentity)).rejects.toThrow(
        UnavailableError,
      );
    });

    it('maps a downstream deadline to UnavailableError', async () => {
      const { service, users, timeouts } = buildMocks();
      timeouts.fast = 10;
      users.service.getAddress.mockReturnValue(NEVER);

      await expect(service.createOrder(validInput, customerIdentity)).rejects.toThrow(
        UnavailableError,
      );
    });

    it('snapshots the shipping address in the order', async () => {
      const { service, prisma } = buildMocks();

      await service.createOrder(validInput, customerIdentity);

      const createArg = prisma.order.create.mock.calls[0][0];
      expect(createArg.data.shippingAddress).toEqual({
        street: '1 Main',
        city: 'NY',
        state: 'NY',
        postalCode: '10001',
        country: 'US',
      });
    });

    it('creates a PENDING status history entry', async () => {
      const { service, prisma } = buildMocks();

      await service.createOrder(validInput, customerIdentity);

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
      const order = makePrismaOrder({ userId: USER_1 });
      prisma.order.findUnique.mockResolvedValue(order);

      const result = await service.getOrder({ orderId: order.id }, customerIdentity);

      expect(result).toBe(order);
    });

    it('allows admin to view any order', async () => {
      const { service, prisma } = buildMocks();
      const order = makePrismaOrder({ userId: USER_2 });
      prisma.order.findUnique.mockResolvedValue(order);

      const result = await service.getOrder({ orderId: order.id }, adminIdentity);

      expect(result).toBe(order);
    });

    it('throws NotFoundError when order does not exist', async () => {
      const { service, prisma } = buildMocks();
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(service.getOrder({ orderId: uuid() }, customerIdentity)).rejects.toThrow(
        NotFoundError,
      );
    });

    it("throws NotFoundError (not PERMISSION_DENIED) for another user's order", async () => {
      const { service, prisma } = buildMocks();
      const order = makePrismaOrder({ userId: USER_1 });
      prisma.order.findUnique.mockResolvedValue(order);

      await expect(service.getOrder({ orderId: order.id }, otherUserIdentity)).rejects.toThrow(
        NotFoundError,
      );
    });

    it('throws ValidationError for invalid orderId', async () => {
      const { service } = buildMocks();

      await expect(service.getOrder({ orderId: 'not-a-uuid' }, customerIdentity)).rejects.toThrow(
        ValidationError,
      );
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

      const result = await service.listMyOrders({}, USER_1);

      expect(prisma.order.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: USER_1 }),
        }),
      );
      expect(result.orders).toEqual(orders);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it('accepts the proto-loader shape for an unset pagination (null)', async () => {
      const { service, prisma } = buildMocks();

      const result = await service.listMyOrders({ pagination: null }, USER_1);

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('orders by createdAt with an id tie-break', async () => {
      const { service, prisma } = buildMocks();

      await service.listMyOrders({}, USER_1);

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      );
    });

    it('applies status filter when provided', async () => {
      const { service, prisma } = buildMocks();

      // Proto enum value 2 = ORDER_STATUS_CONFIRMED → 'CONFIRMED'
      await service.listMyOrders({ status: 2 }, USER_1);

      expect(prisma.order.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: USER_1, status: 'CONFIRMED' }),
        }),
      );
    });

    it('treats ORDER_STATUS_UNSPECIFIED (0) as no filter', async () => {
      const { service, prisma } = buildMocks();

      await service.listMyOrders({ status: 0 }, USER_1);

      expect(prisma.order.count).toHaveBeenCalledWith({
        where: { userId: USER_1, status: undefined },
      });
    });

    it('rejects an unknown status value instead of ignoring it', async () => {
      const { service, prisma } = buildMocks();

      await expect(service.listMyOrders({ status: 99 }, USER_1)).rejects.toThrow(ValidationError);
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // listAllOrders
  // -------------------------------------------------------------------------
  describe('listAllOrders', () => {
    it('returns all orders without user filter', async () => {
      const { service, prisma } = buildMocks();

      const result = await service.listAllOrders({});

      expect(prisma.order.count).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
      expect(result.totalPages).toBe(1);
    });

    it('filters by userId when provided', async () => {
      const { service, prisma } = buildMocks();

      await service.listAllOrders({ userId: USER_1 });

      expect(prisma.order.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: USER_1 }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // cancelOrder
  // -------------------------------------------------------------------------
  describe('cancelOrder', () => {
    it('transitions PENDING → CANCELLED and enqueues outbox event', async () => {
      const { service, prisma, outbox, stateMachine, lockedOrder } = buildMocks();
      const orderId = uuid();
      lockedOrder('PENDING');

      await service.cancelOrder({ orderId, reason: 'changed mind' }, customerIdentity);

      expect(stateMachine.transition).toHaveBeenCalledWith(
        prisma,
        orderId,
        'cancel',
        expect.objectContaining({ reason: 'changed mind' }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: orderId },
        data: { status: 'CANCELLED' },
      });
      expect(outbox.enqueue).toHaveBeenCalledWith(prisma, {
        aggregateType: 'Order',
        aggregateId: orderId,
        topic: TOPICS.ORDER_CANCELLED,
        payload: { orderId, userId: USER_1, reason: 'changed mind' },
        correlationId: 'req-1',
      });
    });

    it('allows the owner to cancel a CONFIRMED order', async () => {
      const { service, lockedOrder } = buildMocks();
      lockedOrder('CONFIRMED');

      await expect(
        service.cancelOrder({ orderId: uuid() }, customerIdentity),
      ).resolves.toBeDefined();
    });

    it("allows admin to cancel any order; the event carries the owner's userId", async () => {
      const { service, outbox, lockedOrder } = buildMocks();
      lockedOrder('PENDING', USER_2);

      await service.cancelOrder({ orderId: uuid() }, adminIdentity);

      expect(outbox.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ payload: expect.objectContaining({ userId: USER_2 }) }),
      );
    });

    it("throws NotFoundError for another user's order and writes nothing", async () => {
      const { service, prisma, outbox, lockedOrder } = buildMocks();
      lockedOrder('PENDING', USER_1);

      await expect(service.cancelOrder({ orderId: uuid() }, otherUserIdentity)).rejects.toThrow(
        NotFoundError,
      );
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when order does not exist', async () => {
      const { service } = buildMocks();

      await expect(service.cancelOrder({ orderId: uuid() }, customerIdentity)).rejects.toThrow(
        NotFoundError,
      );
    });

    it('throws FailedPreconditionError for a SHIPPED order and enqueues nothing', async () => {
      const { service, outbox, lockedOrder } = buildMocks();
      lockedOrder('SHIPPED');

      await expect(service.cancelOrder({ orderId: uuid() }, customerIdentity)).rejects.toThrow(
        FailedPreconditionError,
      );
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // shipOrder
  // -------------------------------------------------------------------------
  describe('shipOrder', () => {
    it('admin-only: transitions CONFIRMED → SHIPPED and enqueues outbox event', async () => {
      const { service, prisma, outbox, stateMachine, lockedOrder } = buildMocks();
      const orderId = uuid();
      lockedOrder('CONFIRMED');

      await service.shipOrder({ orderId }, adminIdentity);

      expect(stateMachine.transition).toHaveBeenCalledWith(
        prisma,
        orderId,
        'ship',
        expect.objectContaining({ reason: undefined }),
      );
      expect(outbox.enqueue).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          topic: TOPICS.ORDER_SHIPPED,
          payload: { orderId, userId: USER_1 },
        }),
      );
    });

    it('throws FailedPreconditionError when the order is still PENDING', async () => {
      const { service, lockedOrder } = buildMocks();
      lockedOrder('PENDING');

      await expect(service.shipOrder({ orderId: uuid() }, adminIdentity)).rejects.toThrow(
        FailedPreconditionError,
      );
    });

    it('throws PermissionDeniedError for non-admin', async () => {
      const { service, prisma } = buildMocks();

      await expect(service.shipOrder({ orderId: uuid() }, customerIdentity)).rejects.toThrow(
        PermissionDeniedError,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // deliverOrder
  // -------------------------------------------------------------------------
  describe('deliverOrder', () => {
    it('admin-only: transitions SHIPPED → DELIVERED', async () => {
      const { service, prisma, outbox, stateMachine, lockedOrder } = buildMocks();
      const orderId = uuid();
      lockedOrder('SHIPPED');

      await service.deliverOrder({ orderId }, adminIdentity);

      expect(stateMachine.transition).toHaveBeenCalledWith(
        prisma,
        orderId,
        'deliver',
        expect.anything(),
      );
      expect(outbox.enqueue).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ topic: TOPICS.ORDER_DELIVERED }),
      );
    });

    it('throws PermissionDeniedError for non-admin', async () => {
      const { service } = buildMocks();

      await expect(service.deliverOrder({ orderId: uuid() }, customerIdentity)).rejects.toThrow(
        PermissionDeniedError,
      );
    });
  });
});
