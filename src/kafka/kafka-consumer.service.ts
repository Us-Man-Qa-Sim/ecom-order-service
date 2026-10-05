import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { parseEvent, type TopicName } from '@us-man-qa-sim/ecom-contracts/events';
import type { Env } from '../config/env.validation';
import type { TopicHandler } from './consumer';

@Injectable()
export class KafkaConsumerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private readonly kafka: KafkaJS.Kafka;
  private readonly groupId: string;
  private readonly handlers = new Map<string, TopicHandler>();
  private consumer?: KafkaJS.Consumer;

  constructor(config: ConfigService<Env, true>) {
    const brokers = config.get('KAFKA_BROKERS', { infer: true }).split(',');
    const clientId = config.get('KAFKA_CLIENT_ID', { infer: true });
    this.groupId = config.get('KAFKA_CONSUMER_GROUP_ID', { infer: true });
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

    this.consumer = this.kafka.consumer({
      kafkaJS: { groupId: this.groupId, autoCommit: false },
    });
    await this.consumer.connect();

    const topics = [...this.handlers.keys()];
    await this.consumer.subscribe({ topics, fromBeginning: false });

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
      this.logger.warn({ topic, partition, offset: message.offset }, 'Empty message value, skipping');
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

    await handler.handle(event);
    await this.commit(topic, partition, message.offset);
  }

  private async commit(topic: string, partition: number, offset: string): Promise<void> {
    await this.consumer!.commitOffsets([
      { topic, partition, offset: String(Number(offset) + 1) },
    ]);
  }
}
