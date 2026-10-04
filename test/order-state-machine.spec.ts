import { OrderStatus, Prisma } from '@prisma/client';
import {
  FailedPreconditionError,
  NotFoundError,
  PermissionDeniedError,
} from '../src/common/errors/domain-errors';
import {
  resolveTransition,
  getAllowedTriggers,
  OrderStateMachine,
  TransitionTrigger,
} from '../src/order/order-state-machine';

// ---------------------------------------------------------------------------
// Pure function tests (no DB, no DI)
// ---------------------------------------------------------------------------
describe('resolveTransition', () => {
  const valid: [OrderStatus, TransitionTrigger, OrderStatus][] = [
    ['PENDING', 'stock_reserved', 'CONFIRMED'],
    ['PENDING', 'stock_reservation_failed', 'CANCELLED'],
    ['PENDING', 'cancel', 'CANCELLED'],
    ['CONFIRMED', 'cancel', 'CANCELLED'],
    ['CONFIRMED', 'ship', 'SHIPPED'],
    ['SHIPPED', 'deliver', 'DELIVERED'],
  ];

  it.each(valid)('%s + %s → %s', (from, trigger, expected) => {
    expect(resolveTransition(from, trigger)).toBe(expected);
  });

  const invalid: [OrderStatus, TransitionTrigger][] = [
    ['CONFIRMED', 'stock_reserved'],
    ['CONFIRMED', 'deliver'],
    ['SHIPPED', 'cancel'],
    ['SHIPPED', 'ship'],
    ['DELIVERED', 'cancel'],
    ['DELIVERED', 'deliver'],
    ['DELIVERED', 'ship'],
    ['CANCELLED', 'cancel'],
    ['CANCELLED', 'ship'],
    ['CANCELLED', 'stock_reserved'],
    ['PENDING', 'ship'],
    ['PENDING', 'deliver'],
  ];

  it.each(invalid)('%s + %s → FailedPreconditionError', (from, trigger) => {
    expect(() => resolveTransition(from, trigger)).toThrow(FailedPreconditionError);
  });
});

describe('getAllowedTriggers', () => {
  it('PENDING allows stock_reserved, stock_reservation_failed, cancel', () => {
    expect(getAllowedTriggers('PENDING').sort()).toEqual(
      ['cancel', 'stock_reservation_failed', 'stock_reserved'].sort(),
    );
  });

  it('CONFIRMED allows cancel, ship', () => {
    expect(getAllowedTriggers('CONFIRMED').sort()).toEqual(['cancel', 'ship'].sort());
  });

  it('SHIPPED allows deliver', () => {
    expect(getAllowedTriggers('SHIPPED')).toEqual(['deliver']);
  });

  it('DELIVERED is terminal', () => {
    expect(getAllowedTriggers('DELIVERED')).toEqual([]);
  });

  it('CANCELLED is terminal', () => {
    expect(getAllowedTriggers('CANCELLED')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OrderStateMachine.transition (injectable service) — uses a mock tx
// ---------------------------------------------------------------------------
describe('OrderStateMachine.transition', () => {
  let sm: OrderStateMachine;
  let tx: {
    $queryRaw: jest.Mock;
    order: { update: jest.Mock };
    orderStatusHistory: { create: jest.Mock };
  };
  const asTx = () => tx as unknown as Prisma.TransactionClient;

  // The locked read returns snake_case columns straight from SQL.
  function lockedRow(status: OrderStatus, userId = 'user-1') {
    tx.$queryRaw.mockResolvedValue([{ user_id: userId, status }]);
  }

  beforeEach(() => {
    sm = new OrderStateMachine();
    tx = {
      $queryRaw: jest.fn(),
      order: { update: jest.fn().mockResolvedValue({}) },
      orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    };
  });

  it('transitions PENDING → CONFIRMED via stock_reserved', async () => {
    lockedRow('PENDING');

    const result = await sm.transition(asTx(), 'order-1', 'stock_reserved');

    expect(result).toEqual({ userId: 'user-1', fromStatus: 'PENDING', toStatus: 'CONFIRMED' });
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { status: 'CONFIRMED' },
    });
    expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
      data: {
        orderId: 'order-1',
        fromStatus: 'PENDING',
        toStatus: 'CONFIRMED',
        reason: null,
      },
    });
  });

  it('reads the order row with FOR UPDATE so concurrent transitions serialise', async () => {
    lockedRow('CONFIRMED');

    await sm.transition(asTx(), 'order-1', 'ship');

    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toMatch(/FOR UPDATE/);
    expect(values).toEqual(['order-1']);
  });

  it('stores reason when provided', async () => {
    lockedRow('PENDING');

    await sm.transition(asTx(), 'order-1', 'cancel', { reason: 'User requested cancellation' });

    expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: 'User requested cancellation' }),
    });
  });

  it('throws NotFoundError when order not found', async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(sm.transition(asTx(), 'missing-id', 'cancel')).rejects.toThrow(NotFoundError);
  });

  it('throws FailedPreconditionError for illegal transition', async () => {
    lockedRow('DELIVERED');

    await expect(sm.transition(asTx(), 'order-1', 'cancel')).rejects.toThrow(
      FailedPreconditionError,
    );

    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('passes the locked row to authorize and aborts before writing when it throws', async () => {
    lockedRow('PENDING', 'owner-1');
    const authorize = jest.fn(() => {
      throw new PermissionDeniedError('nope');
    });

    await expect(sm.transition(asTx(), 'order-1', 'cancel', { authorize })).rejects.toThrow(
      PermissionDeniedError,
    );

    expect(authorize).toHaveBeenCalledWith({ id: 'order-1', userId: 'owner-1', status: 'PENDING' });
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('transitions CONFIRMED → CANCELLED via cancel', async () => {
    lockedRow('CONFIRMED');

    const result = await sm.transition(asTx(), 'order-1', 'cancel', { reason: 'Out of stock' });

    expect(result).toEqual({ userId: 'user-1', fromStatus: 'CONFIRMED', toStatus: 'CANCELLED' });
  });

  it('transitions CONFIRMED → SHIPPED via ship', async () => {
    lockedRow('CONFIRMED');

    const result = await sm.transition(asTx(), 'order-1', 'ship');

    expect(result).toEqual({ userId: 'user-1', fromStatus: 'CONFIRMED', toStatus: 'SHIPPED' });
  });

  it('transitions SHIPPED → DELIVERED via deliver', async () => {
    lockedRow('SHIPPED');

    const result = await sm.transition(asTx(), 'order-1', 'deliver');

    expect(result).toEqual({ userId: 'user-1', fromStatus: 'SHIPPED', toStatus: 'DELIVERED' });
  });
});
