import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { TOPICS } from '@us-man-qa-sim/ecom-contracts/events';
import { FailedPreconditionError, NotFoundError } from '../src/common/errors/domain-errors';
import { StockReservedHandler } from '../src/kafka/handlers/stock-reserved.handler';

const uuid = () => randomUUID();

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: uuid(),
    eventType: TOPICS.ORDER_STOCK_RESERVED,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: uuid(),
    payload: { orderId: uuid() },
    ...overrides,
  };
}

describe('StockReservedHandler', () => {
  let handler: StockReservedHandler;
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
        toStatus: 'CONFIRMED',
      }),
    };
    consumerService = { subscribe: jest.fn() };

    handler = new StockReservedHandler(
      prisma as any,
      outbox as any,
      stateMachine as any,
      consumerService as any,
    );
  });

  it('subscribes to the stock-reserved topic on init', () => {
    handler.onModuleInit();
    expect(consumerService.subscribe).toHaveBeenCalledWith(TOPICS.ORDER_STOCK_RESERVED, handler);
  });

  it('transitions order to CONFIRMED and enqueues order.confirmed', async () => {
    const event = makeEvent();

    await handler.handle(event);

    expect(stateMachine.transition).toHaveBeenCalledWith(
      expect.anything(),
      event.payload.orderId,
      'stock_reserved',
    );
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.anything(), {
      aggregateType: 'Order',
      aggregateId: event.payload.orderId,
      topic: TOPICS.ORDER_CONFIRMED,
      payload: { orderId: event.payload.orderId, userId: USER_ID },
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
      data: { eventId: event.eventId, eventType: TOPICS.ORDER_STOCK_RESERVED },
    });
  });

  // KFK-7: the user cancelled while product-service was reserving, so the
  // stock result finds the order already CANCELLED.
  it('ignores a stale result for an order that already left PENDING', async () => {
    const event = makeEvent();
    let capturedTx: any;
    prisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => {
      capturedTx = { processedEvent: { create: jest.fn() } };
      return fn(capturedTx);
    });
    stateMachine.transition.mockRejectedValueOnce(
      new FailedPreconditionError("Cannot apply 'stock_reserved' to order in status CANCELLED"),
    );

    await expect(handler.handle(event)).resolves.toBeUndefined();

    // Inbox row is still written (the tx commits), so a redelivery is a no-op.
    expect(capturedTx.processedEvent.create).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('still rethrows other state-machine errors (e.g. unknown order)', async () => {
    stateMachine.transition.mockRejectedValueOnce(new NotFoundError('Order not found'));

    await expect(handler.handle(makeEvent())).rejects.toBeInstanceOf(NotFoundError);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
