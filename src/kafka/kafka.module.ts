import { Global, Module } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import { PUBLISHER } from './publisher';

@Global()
@Module({
  providers: [
    KafkaProducerService,
    { provide: PUBLISHER, useExisting: KafkaProducerService },
  ],
  exports: [KafkaProducerService, PUBLISHER],
})
export class KafkaModule {}
