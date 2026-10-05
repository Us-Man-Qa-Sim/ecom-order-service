import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { parseEvent, type TopicName } from '@us-man-qa-sim/ecom-contracts/events';
import type { Env } from '../config/env.validation';
import { CorrelationService } from '../correlation/correlation.service';
import type { TopicHandler } from './consumer';

@Injectable()
export class KafkaConsumerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private readonly kafka: KafkaJS.Kafka;
  private readonly groupId: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly handlers = new Map<string, TopicHandler>();
  private consumer?: KafkaJS.Consumer;

  constructor(
    config: ConfigService<Env, true>,
    private readonly correlation: CorrelationService,
  ) {
    const brokers = config.get('KAFKA_BROKERS', { infer: true }).split(',');
    const clientId = config.get('KAFKA_CLIENT_ID', { infer: true });
    this.groupId = config.get('KAFKA_CONSUMER_GROUP_ID', { infer: true });
    this.maxRetries = config.get('KAFKA_CONSUMER_MAX_RETRIES', { infer: true });
    this.retryBaseMs = config.get('KAFKA_CONSUMER_RETRY_BASE_MS', { infer: true });
    this.retryMaxMs = config.get('KAFKA_CONSUMER_RETRY_MAX_MS', { infer: true });
    this.kafka = new KafkaJS.Kafka({ kafkaJS: { brokers, clientId } });
  }

  subscribe<T extends TopicName>(topic: T, handler: TopicHandler<T>): void {
    if (this.consumer) {
      throw new Error('Cannot subscribe after the consumer has started');
    }
    this.handlers.set(topic, handler as TopicHandler);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.handlers.size === 0) {
      this.logger.log('No topic handlers registered, skipping consumer start');
      return;
    }

    // fromBeginning: a brand-new consumer group (first deploy, or a group that
    // was reset) starts at the earliest offset instead of `latest`, so events
    // produced before this service first joined are not silently skipped.
    // Once the group has committed offsets this setting has no effect.
    this.consumer = this.kafka.consumer({
      kafkaJS: { groupId: this.groupId, autoCommit: false, fromBeginning: true },
    });
    await this.consumer.connect();

    const topics = [...this.handlers.keys()];
    await this.consumer.subscribe({ topics });

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        await this.handleMessage(topic as TopicName, partition, message);
      },
    });

    this.logger.log(
      `Kafka consumer started (group=${this.groupId}, topics=[${topics.join(', ')}])`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.consumer) {
      await this.consumer.disconnect();
      this.logger.log('Kafka consumer disconnected');
    }
  }

  private async handleMessage(
    topic: TopicName,
    partition: number,
    message: KafkaJS.KafkaMessage,
  ): Promise<void> {
    const handler = this.handlers.get(topic);
    if (!handler) {
      this.logger.warn({ topic }, 'No handler registered for topic');
      return;
    }

    const raw = message.value?.toString();
    if (!raw) {
      this.logger.warn(
        { topic, partition, offset: message.offset },
        'Empty message value, skipping',
      );
      await this.commit(topic, partition, message.offset);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.error(
        { topic, partition, offset: message.offset },
        'Message is not valid JSON, skipping',
      );
      await this.commit(topic, partition, message.offset);
      return;
    }

    let event;
    try {
      event = parseEvent(topic, parsed);
    } catch (err) {
      this.logger.error(
        { err, topic, partition, offset: message.offset },
        'Envelope validation failed, skipping',
      );
      await this.commit(topic, partition, message.offset);
      return;
    }

    await this.correlation.run({ correlationId: event.correlationId }, async () => {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          await handler.handle(event);
          await this.commit(topic, partition, message.offset);
          return;
        } catch (err) {
          if (attempt < this.maxRetries) {
            const delay = this.backoffDelay(attempt);
            this.logger.warn(
              {
                err,
                topic,
                partition,
                offset: message.offset,
                attempt,
                maxRetries: this.maxRetries,
                nextRetryMs: delay,
              },
              'Handler failed, retrying after backoff',
            );
            await this.sleep(delay);
          } else {
            this.logger.error(
              {
                err,
                topic,
                partition,
                offset: message.offset,
                attempts: this.maxRetries,
                eventId: event.eventId,
                correlationId: event.correlationId,
              },
              'Poison message: handler failed after all retries, skipping',
            );
            await this.commit(topic, partition, message.offset);
          }
        }
      }
    });
  }

  private backoffDelay(attempt: number): number {
    const exponential = this.retryBaseMs * 2 ** (attempt - 1);
    const capped = Math.min(exponential, this.retryMaxMs);
    const jitter = Math.random() * capped * 0.2;
    return Math.floor(capped + jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async commit(topic: string, partition: number, offset: string): Promise<void> {
    await this.consumer!.commitOffsets([{ topic, partition, offset: String(Number(offset) + 1) }]);
  }
}
