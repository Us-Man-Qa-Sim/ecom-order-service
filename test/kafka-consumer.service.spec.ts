import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.validation';
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

function makeConfig(): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_CLIENT_ID: 'order-service',
    KAFKA_CONSUMER_GROUP_ID: 'order-service',
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
    service = new KafkaConsumerService(makeConfig());
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

  it('does NOT commit when the handler throws', async () => {
    const handle = jest.fn().mockRejectedValueOnce(new Error('processing failed'));
    service.subscribe(TOPICS.ORDER_STOCK_RESERVED, { handle });
    await service.onApplicationBootstrap();

    const envelope = validEnvelope(TOPICS.ORDER_STOCK_RESERVED);
    await expect(
      capturedEachMessage!({
        topic: TOPICS.ORDER_STOCK_RESERVED,
        partition: 0,
        message: {
          key: Buffer.from('key'),
          value: Buffer.from(JSON.stringify(envelope)),
          timestamp: Date.now().toString(),
          attributes: 0,
          offset: '7',
          headers: {},
        },
      }),
    ).rejects.toThrow('processing failed');

    expect(commitOffsets).not.toHaveBeenCalled();
  });
});
