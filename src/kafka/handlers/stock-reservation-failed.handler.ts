import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TOPICS, type TypedEventEnvelope } from '@us-man-qa-sim/ecom-contracts/events';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { OrderStateMachine } from '../../order/order-state-machine';
import type { TopicHandler } from '../consumer';
import { KafkaConsumerService } from '../kafka-consumer.service';

@Injectable()
export class StockReservationFailedHandler
  implements TopicHandler<'order.stock-reservation-failed'>, OnModuleInit
{
  private readonly logger = new Logger(StockReservationFailedHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly stateMachine: OrderStateMachine,
    private readonly consumerService: KafkaConsumerService,
  ) {}

  onModuleInit(): void {
    this.consumerService.subscribe(TOPICS.ORDER_STOCK_RESERVATION_FAILED, this);
  }

  async handle(event: TypedEventEnvelope<'order.stock-reservation-failed'>): Promise<void> {
    const { eventId, correlationId, payload } = event;
    const { orderId, reason } = payload;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: { eventId, eventType: TOPICS.ORDER_STOCK_RESERVATION_FAILED },
        });

        const { userId } = await this.stateMachine.transition(
          tx,
          orderId,
          'stock_reservation_failed',
          { reason },
        );

        await this.outbox.enqueue(tx, {
          aggregateType: 'Order',
          aggregateId: orderId,
          topic: TOPICS.ORDER_CANCELLED,
          payload: { orderId, userId, reason },
          correlationId,
        });
      });

      this.logger.log({ orderId, reason }, 'Order cancelled (stock reservation failed)');
    } catch (err: unknown) {
      if (isDuplicateEvent(err)) {
        this.logger.log({ eventId }, 'Duplicate event, skipping');
        return;
      }
      throw err;
    }
  }
}

function isDuplicateEvent(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
