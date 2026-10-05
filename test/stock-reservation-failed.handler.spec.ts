import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { TOPICS } from '@us-man-qa-sim/ecom-contracts/events';
import { StockReservationFailedHandler } from '../src/kafka/handlers/stock-reservation-failed.handler';

const uuid = () => randomUUID();

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: uuid(),
    eventType: TOPICS.ORDER_STOCK_RESERVATION_FAILED,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: uuid(),
    payload: { orderId: uuid(), reason: 'Insufficient stock for Widget' },
    ...overrides,
  };
}

describe('StockReservationFailedHandler', () => {
  let handler: StockReservationFailedHandler;
  let prisma: { $transaction: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let stateMachine: { transition: jest.Mock };
  let consumerService: { subscribe: jest.Mock };

  const USER_ID = uuid();

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          processedEvent: { create: jest.fn() },
        };
        return fn(tx);
      }),
    };
    outbox = { enqueue: jest.fn() };
    stateMachine = {
      transition: jest.fn().mockResolvedValue({
        userId: USER_ID,
        fromStatus: 'PENDING',
        toStatus: 'CANCELLED',
      }),
    };
    consumerService = { subscribe: jest.fn() };

    handler = new StockReservationFailedHandler(
      prisma as any,
      outbox as any,
      stateMachine as any,
      consumerService as any,
    );
  });

  it('subscribes to the stock-reservation-failed topic on init', () => {
    handler.onModuleInit();
    expect(consumerService.subscribe).toHaveBeenCalledWith(
      TOPICS.ORDER_STOCK_RESERVATION_FAILED,
      handler,
    );
  });

  it('transitions order to CANCELLED and enqueues order.cancelled with reason', async () => {
    const event = makeEvent();

    await handler.handle(event);

    expect(stateMachine.transition).toHaveBeenCalledWith(
      expect.anything(),
      event.payload.orderId,
      'stock_reservation_failed',
      { reason: event.payload.reason },
    );
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.anything(), {
      aggregateType: 'Order',
      aggregateId: event.payload.orderId,
      topic: TOPICS.ORDER_CANCELLED,
      payload: {
        orderId: event.payload.orderId,
        userId: USER_ID,
        reason: event.payload.reason,
      },
      correlationId: event.correlationId,
    });
  });

  it('skips duplicate events (P2002)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: '6.0.0',
    });
    prisma.$transaction.mockRejectedValueOnce(p2002);

    await expect(handler.handle(makeEvent())).resolves.toBeUndefined();
  });

  it('rethrows non-duplicate errors', async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error('db down'));

    await expect(handler.handle(makeEvent())).rejects.toThrow('db down');
  });

  it('records the event in processed_events (inbox)', async () => {
    const event = makeEvent();
    let capturedTx: any;
    prisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<void>) => {
      capturedTx = { processedEvent: { create: jest.fn() } };
      return fn(capturedTx);
    });

    await handler.handle(event);

    expect(capturedTx.processedEvent.create).toHaveBeenCalledWith({
      data: { eventId: event.eventId, eventType: TOPICS.ORDER_STOCK_RESERVATION_FAILED },
    });
  });
});
