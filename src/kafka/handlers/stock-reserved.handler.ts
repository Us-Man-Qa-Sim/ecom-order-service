import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TOPICS, type TypedEventEnvelope } from '@us-man-qa-sim/ecom-contracts/events';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { OrderStateMachine } from '../../order/order-state-machine';
import { applyIfPending } from './apply-if-pending';
import type { TopicHandler } from '../consumer';
import { KafkaConsumerService } from '../kafka-consumer.service';

@Injectable()
export class StockReservedHandler implements TopicHandler<'order.stock-reserved'>, OnModuleInit {
  private readonly logger = new Logger(StockReservedHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly stateMachine: OrderStateMachine,
    private readonly consumerService: KafkaConsumerService,
  ) {}

  onModuleInit(): void {
    this.consumerService.subscribe(TOPICS.ORDER_STOCK_RESERVED, this);
  }

  async handle(event: TypedEventEnvelope<'order.stock-reserved'>): Promise<void> {
    const { eventId, correlationId, payload } = event;
    const { orderId } = payload;

    try {
      const applied = await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: { eventId, eventType: TOPICS.ORDER_STOCK_RESERVED },
        });

        const result = await applyIfPending(() =>
          this.stateMachine.transition(tx, orderId, 'stock_reserved'),
        );
        if (!result) return false;

        await this.outbox.enqueue(tx, {
          aggregateType: 'Order',
          aggregateId: orderId,
          topic: TOPICS.ORDER_CONFIRMED,
          payload: { orderId, userId: result.userId },
          correlationId,
        });
        return true;
      });

      if (applied) {
        this.logger.log({ orderId }, 'Order confirmed');
      } else {
        this.logger.warn(
          { orderId, eventId },
          'Stale stock result: order is no longer PENDING (e.g. cancelled while the reservation was in flight), ignoring',
        );
      }
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
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
