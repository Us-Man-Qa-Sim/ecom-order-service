import { OrderStatus } from '@prisma/client';
import { FailedPreconditionError } from '../src/common/errors/domain-errors';
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
    order: { findUnique: jest.Mock; update: jest.Mock };
    orderStatusHistory: { create: jest.Mock };
  };

  beforeEach(() => {
    sm = new OrderStateMachine();
    tx = {
      order: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      orderStatusHistory: {
        create: jest.fn(),
      },
    };
  });

  it('transitions PENDING → CONFIRMED via stock_reserved', async () => {
    tx.order.findUnique.mockResolvedValue({ status: 'PENDING' });
    tx.order.update.mockResolvedValue({});
    tx.orderStatusHistory.create.mockResolvedValue({});

    const result = await sm.transition(tx as any, 'order-1', 'stock_reserved');

    expect(result).toEqual({ fromStatus: 'PENDING', toStatus: 'CONFIRMED' });
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

  it('stores reason when provided', async () => {
    tx.order.findUnique.mockResolvedValue({ status: 'PENDING' });
    tx.order.update.mockResolvedValue({});
    tx.orderStatusHistory.create.mockResolvedValue({});

    await sm.transition(tx as any, 'order-1', 'cancel', 'User requested cancellation');

    expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: 'User requested cancellation' }),
    });
  });

  it('throws FailedPreconditionError when order not found', async () => {
    tx.order.findUnique.mockResolvedValue(null);

    await expect(sm.transition(tx as any, 'missing-id', 'cancel')).rejects.toThrow(
      FailedPreconditionError,
    );
  });

  it('throws FailedPreconditionError for illegal transition', async () => {
    tx.order.findUnique.mockResolvedValue({ status: 'DELIVERED' });

    await expect(sm.transition(tx as any, 'order-1', 'cancel')).rejects.toThrow(
      FailedPreconditionError,
    );

    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('transitions CONFIRMED → CANCELLED via cancel', async () => {
    tx.order.findUnique.mockResolvedValue({ status: 'CONFIRMED' });
    tx.order.update.mockResolvedValue({});
    tx.orderStatusHistory.create.mockResolvedValue({});

    const result = await sm.transition(tx as any, 'order-1', 'cancel', 'Out of stock');

    expect(result).toEqual({ fromStatus: 'CONFIRMED', toStatus: 'CANCELLED' });
  });

  it('transitions CONFIRMED → SHIPPED via ship', async () => {
    tx.order.findUnique.mockResolvedValue({ status: 'CONFIRMED' });
    tx.order.update.mockResolvedValue({});
    tx.orderStatusHistory.create.mockResolvedValue({});

    const result = await sm.transition(tx as any, 'order-1', 'ship');

    expect(result).toEqual({ fromStatus: 'CONFIRMED', toStatus: 'SHIPPED' });
  });

  it('transitions SHIPPED → DELIVERED via deliver', async () => {
    tx.order.findUnique.mockResolvedValue({ status: 'SHIPPED' });
    tx.order.update.mockResolvedValue({});
    tx.orderStatusHistory.create.mockResolvedValue({});

    const result = await sm.transition(tx as any, 'order-1', 'deliver');

    expect(result).toEqual({ fromStatus: 'SHIPPED', toStatus: 'DELIVERED' });
  });
});
