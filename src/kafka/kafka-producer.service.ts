import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Env } from '../config/env.validation';
import { OutboundMessage, Publisher } from './publisher';

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnApplicationShutdown, Publisher {
  private readonly logger = new Logger(KafkaProducerService.name);
  private readonly kafka: KafkaJS.Kafka;
  private producer?: KafkaJS.Producer;
  private connected = false;

  constructor(config: ConfigService<Env, true>) {
    const brokers = config.get('KAFKA_BROKERS', { infer: true }).split(',');
    const clientId = config.get('KAFKA_CLIENT_ID', { infer: true });
    this.kafka = new KafkaJS.Kafka({ kafkaJS: { brokers, clientId } });
  }

  async onModuleInit(): Promise<void> {
    this.producer = this.kafka.producer({
      kafkaJS: {
        idempotent: true,
        acks: -1,
        timeout: 30_000,
      },
    });
    await this.producer.connect();
    this.connected = true;
    this.logger.log('Kafka producer connected');
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.producer && this.connected) {
      try {
        await this.producer.flush({ timeout: 5_000 });
      } catch (err) {
        this.logger.warn({ err }, 'Kafka producer flush failed on shutdown');
      }
      await this.producer.disconnect();
      this.connected = false;
      this.logger.log('Kafka producer disconnected');
    }
  }

  async publish(message: OutboundMessage): Promise<void> {
    if (!this.producer || !this.connected) {
      throw new Error('Kafka producer not connected');
    }
    await this.producer.send({
      topic: message.topic,
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: message.headers,
        },
      ],
    });
  }
}
