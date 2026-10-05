import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.validation';
import { CorrelationService } from '../src/correlation/correlation.service';
import { KafkaConsumerService } from '../src/kafka/kafka-consumer.service';
import type { TopicHandler } from '../src/kafka/consumer';
import { TOPICS } from '@us-man-qa-sim/ecom-contracts/events';

const commitOffsets = jest.fn();
const consumerDisconnect = jest.fn();
const consumerSubscribe = jest.fn();
const consumerConnect = jest.fn();
let capturedEachMessage: ((payload: unknown) => Promise<void>) | undefined;
const consumerRun = jest.fn(async (config: { eachMessage: (p: unknown) => Promise<void> }) => {
  capturedEachMessage = config.eachMessage;
});

jest.mock('@confluentinc/kafka-javascript', () => ({
  KafkaJS: {
    Kafka: jest.fn().mockImplementation(() => ({
      consumer: jest.fn().mockReturnValue({
        connect: consumerConnect,
        subscribe: consumerSubscribe,
        run: consumerRun,
        commitOffsets,
        disconnect: consumerDisconnect,
      }),
    })),
  },
}));

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_CLIENT_ID: 'order-service',
    KAFKA_CONSUMER_GROUP_ID: 'order-service',
    KAFKA_CONSUMER_MAX_RETRIES: 3,
    KAFKA_CONSUMER_RETRY_BASE_MS: 10,
    KAFKA_CONSUMER_RETRY_MAX_MS: 100,
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService<Env, true>;
}

function validEnvelope(topic: string) {
  return {
    eventId: randomUUID(),
    eventType: topic,
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
    payload: { orderId: randomUUID() },
  };
}

describe('KafkaConsumerService', () => {
  let service: KafkaConsumerService;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedEachMessage = undefined;
    service = new KafkaConsumerService(makeConfig(), new CorrelationService());
  });

  it('subscribes to topics and starts the consumer', async () => {
    service.subscribe(TOPICS.ORDER_STOCK_RESERVED, { handle: jest.fn() });
    service.subscribe(TOPICS.ORDER_STOCK_RESERVATION_FAILED, { handle: jest.fn() });
    await service.onApplicationBootstrap();

    expect(consumerConnect).toHaveBeenCalledTimes(1);
    expect(consumerSubscribe).toHaveBeenCalledWith({
      topics: [TOPICS.ORDER_STOCK_RESERVED, TOPICS.ORDER_STOCK_RESERVATION_FAILED],
      fromBeginning: false,
    });
    expect(consumerRun).toHaveBeenCalled();
  });

  it('validates the envelope and calls the handler on a valid message', async () => {
    const handle = jest.fn();
    service.subscribe(TOPICS.ORDER_STOCK_RESERVED, { handle });
    await service.onApplicationBootstrap();

    const envelope = validEnvelope(TOPICS.ORDER_STOCK_RESERVED);
    await capturedEachMessage!({
      topic: TOPICS.ORDER_STOCK_RESERVED,
      partition: 0,
      message: {
        key: Buffer.from('key'),
        value: Buffer.from(JSON.stringify(envelope)),
        timestamp: Date.now().toString(),
        attributes: 0,
        offset: '10',
        headers: {},
      },
    });

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: envelope.eventId }),
    );
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: TOPICS.ORDER_STOCK_RESERVED, partition: 0, offset: '11' },
    ]);
  });

  it('skips invalid envelopes and commits the offset', async () => {
    const handle = jest.fn();
    service.subscribe(TOPICS.ORDER_STOCK_RESERVED, { handle });
    await service.onApplicationBootstrap();

    await capturedEachMessage!({
      topic: TOPICS.ORDER_STOCK_RESERVED,
      partition: 0,
      message: {
        key: Buffer.from('key'),
        value: Buffer.from(JSON.stringify({ bad: 'data' })),
        timestamp: Date.now().toString(),
        attributes: 0,
        offset: '5',
        headers: {},
      },
    });

    expect(handle).not.toHaveBeenCalled();
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: TOPICS.ORDER_STOCK_RESERVED, partition: 0, offset: '6' },
    ]);
  });

  describe('retry with backoff', () => {
    let handle: jest.Mock;

    beforeEach(async () => {
      handle = jest.fn();
      service.subscribe(TOPICS.ORDER_STOCK_RESERVED, { handle });
      await service.onApplicationBootstrap();
    });

    function stockReservedMessage(offset = '7') {
      const envelope = validEnvelope(TOPICS.ORDER_STOCK_RESERVED);
      return {
        envelope,
        msg: {
          topic: TOPICS.ORDER_STOCK_RESERVED,
          partition: 0,
          message: {
            key: Buffer.from('key'),
            value: Buffer.from(JSON.stringify(envelope)),
            timestamp: Date.now().toString(),
            attributes: 0,
            offset,
            headers: {},
          },
        },
      };
    }

    it('retries and succeeds on second attempt', async () => {
      handle
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce(undefined);
      const { msg } = stockReservedMessage();

      await capturedEachMessage!(msg);

      expect(handle).toHaveBeenCalledTimes(2);
      expect(commitOffsets).toHaveBeenCalledTimes(1);
      expect(commitOffsets).toHaveBeenCalledWith([
        { topic: TOPICS.ORDER_STOCK_RESERVED, partition: 0, offset: '8' },
      ]);
    });

    it('commits as poison message after exhausting all retries', async () => {
      handle.mockRejectedValue(new Error('persistent failure'));
      const { msg } = stockReservedMessage();

      await capturedEachMessage!(msg);

      expect(handle).toHaveBeenCalledTimes(3);
      expect(commitOffsets).toHaveBeenCalledTimes(1);
      expect(commitOffsets).toHaveBeenCalledWith([
        { topic: TOPICS.ORDER_STOCK_RESERVED, partition: 0, offset: '8' },
      ]);
    });

    it('applies backoff delay between retries', async () => {
      handle
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(undefined);
      const sleepSpy = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      const { msg } = stockReservedMessage();

      await capturedEachMessage!(msg);

      expect(sleepSpy).toHaveBeenCalledTimes(1);
      const delay = sleepSpy.mock.calls[0][0] as number;
      expect(delay).toBeGreaterThanOrEqual(10);
      expect(delay).toBeLessThanOrEqual(12);

      sleepSpy.mockRestore();
    });
  });
});
