import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  EVENT_PAYLOAD_SCHEMAS,
  EventPayloadMap,
  TopicName,
  TypedEventEnvelope,
} from '@us-man-qa-sim/ecom-contracts/events';

@Injectable()
export class OutboxService {
  async enqueue<T extends TopicName>(
    tx: Prisma.TransactionClient,
    event: {
      aggregateType: string;
      aggregateId: string;
      topic: T;
      payload: EventPayloadMap[T];
      correlationId?: string;
    },
  ): Promise<void> {
    const parsedPayload = EVENT_PAYLOAD_SCHEMAS[event.topic].parse(event.payload);

    const envelope: TypedEventEnvelope<T> = {
      eventId: randomUUID(),
      eventType: event.topic,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: event.correlationId ?? randomUUID(),
      payload: parsedPayload as EventPayloadMap[T],
    };

    await tx.outbox.create({
      data: {
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.topic,
        payload: envelope as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
