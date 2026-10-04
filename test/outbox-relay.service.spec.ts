import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.validation';
import { OutboxRelayService } from '../src/outbox/outbox-relay.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { Publisher } from '../src/kafka/publisher';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  created_at: Date;
}

function envelope(aggregateId: string, type: string): OutboxRow {
  return {
    id: randomUUID(),
    aggregate_id: aggregateId,
    event_type: type,
    payload: {
      eventId: randomUUID(),
      eventType: type,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      payload: { hello: 'world' },
    },
    created_at: new Date(),
  };
}

function makePrisma(initial: OutboxRow[]) {
  let rows = [...initial];
  const queryRaw = jest.fn(async () => rows.slice());
  const updateMany = jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
    const ids = new Set(where.id.in);
    rows = rows.filter((r) => !ids.has(r.id));
    return { count: ids.size };
  });
  const transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn({ $queryRaw: queryRaw, outbox: { updateMany } });
  });
  return {
    prisma: { $transaction: transaction } as unknown as PrismaService,
    queryRaw,
    updateMany,
    transaction,
    remaining: () => rows.length,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    OUTBOX_RELAY_ENABLED: true,
    OUTBOX_RELAY_POLL_INTERVAL_MS: 250,
    OUTBOX_RELAY_BATCH_SIZE: 32,
    OUTBOX_RELAY_ERROR_BACKOFF_MS: 5000,
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService<Env, true>;
}

function makePublisher(): { publisher: Publisher; publish: jest.Mock } {
  const publish = jest.fn(async () => undefined);
  return { publisher: { publish }, publish };
}

describe('OutboxRelayService.drainOnce', () => {
  it('publishes every unsent row and marks them sent', async () => {
    const rows = [envelope('order-1', 'order.created'), envelope('order-2', 'order.created')];
    const { prisma, updateMany, remaining } = makePrisma(rows);
    const { publisher, publish } = makePublisher();
    const relay = new OutboxRelayService(makeConfig(), prisma, publisher);

    const processed = await relay.drainOnce();

    expect(processed).toBe(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][0]).toMatchObject({
      topic: 'order.created',
      key: 'order-1',
    });
    expect(JSON.parse(publish.mock.calls[0][0].value)).toMatchObject({
      eventType: 'order.created',
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { sentAt: expect.any(Date) },
    });
    expect(remaining()).toBe(0);
  });

  it('returns 0 and never touches the publisher when the queue is empty', async () => {
    const { prisma, updateMany } = makePrisma([]);
    const { publisher, publish } = makePublisher();
    const relay = new OutboxRelayService(makeConfig(), prisma, publisher);

    const processed = await relay.drainOnce();

    expect(processed).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('propagates publish failure so the tx rolls back and rows stay unsent', async () => {
    const rows = [envelope('order-9', 'order.created')];
    const { prisma, updateMany, remaining } = makePrisma(rows);
    const publish = jest.fn(async () => {
      throw new Error('kafka down');
    });
    const relay = new OutboxRelayService(makeConfig(), prisma, { publish } as unknown as Publisher);

    await expect(relay.drainOnce()).rejects.toThrow('kafka down');
    expect(updateMany).not.toHaveBeenCalled();
    expect(remaining()).toBe(1);
  });
});

describe('OutboxRelayService lifecycle', () => {
  it('does not schedule ticks when disabled', () => {
    const { prisma, transaction } = makePrisma([]);
    const { publisher } = makePublisher();
    const relay = new OutboxRelayService(
      makeConfig({ OUTBOX_RELAY_ENABLED: false }),
      prisma,
      publisher,
    );
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    relay.onApplicationBootstrap();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it('stops scheduling further ticks after shutdown', async () => {
    const { prisma } = makePrisma([]);
    const { publisher } = makePublisher();
    const relay = new OutboxRelayService(makeConfig(), prisma, publisher);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    relay.onApplicationBootstrap();
    await relay.onModuleDestroy();
    setTimeoutSpy.mockClear();

    relay.onApplicationBootstrap();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});
