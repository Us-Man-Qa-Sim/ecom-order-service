import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { OutboxRelayService } from './outbox-relay.service';

@Global()
@Module({
  providers: [OutboxService, OutboxRelayService],
  exports: [OutboxService, OutboxRelayService],
})
export class OutboxModule {}
