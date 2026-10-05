import { Global, Module } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import { KafkaConsumerService } from './kafka-consumer.service';
import { PUBLISHER } from './publisher';

@Global()
@Module({
  providers: [
    KafkaProducerService,
    { provide: PUBLISHER, useExisting: KafkaProducerService },
    KafkaConsumerService,
  ],
  exports: [KafkaProducerService, PUBLISHER, KafkaConsumerService],
})
export class KafkaModule {}
