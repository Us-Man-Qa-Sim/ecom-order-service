import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { FailedPreconditionError } from '../common/errors/domain-errors';

export type TransitionTrigger =
  'stock_reserved' | 'stock_reservation_failed' | 'cancel' | 'ship' | 'deliver';

interface TransitionDef {
  from: OrderStatus;
  to: OrderStatus;
  trigger: TransitionTrigger;
}

const TRANSITIONS: readonly TransitionDef[] = [
  { from: 'PENDING', to: 'CONFIRMED', trigger: 'stock_reserved' },
  { from: 'PENDING', to: 'CANCELLED', trigger: 'stock_reservation_failed' },
  { from: 'PENDING', to: 'CANCELLED', trigger: 'cancel' },
  { from: 'CONFIRMED', to: 'CANCELLED', trigger: 'cancel' },
  { from: 'CONFIRMED', to: 'SHIPPED', trigger: 'ship' },
  { from: 'SHIPPED', to: 'DELIVERED', trigger: 'deliver' },
];

const transitionIndex = new Map<string, OrderStatus>();
for (const t of TRANSITIONS) {
  transitionIndex.set(`${t.from}:${t.trigger}`, t.to);
}

export function resolveTransition(from: OrderStatus, trigger: TransitionTrigger): OrderStatus {
  const to = transitionIndex.get(`${from}:${trigger}`);
  if (!to) {
    throw new FailedPreconditionError(`Cannot apply '${trigger}' to order in status ${from}`);
  }
  return to;
}

export function getAllowedTriggers(from: OrderStatus): TransitionTrigger[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.trigger);
}

export interface TransitionResult {
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
}

@Injectable()
export class OrderStateMachine {
  async transition(
    tx: Prisma.TransactionClient,
    orderId: string,
    trigger: TransitionTrigger,
    reason?: string,
  ): Promise<TransitionResult> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });

    if (!order) {
      throw new FailedPreconditionError(`Order ${orderId} not found`);
    }

    const fromStatus = order.status;
    const toStatus = resolveTransition(fromStatus, trigger);

    await tx.order.update({
      where: { id: orderId },
      data: { status: toStatus },
    });

    await tx.orderStatusHistory.create({
      data: {
        orderId,
        fromStatus,
        toStatus,
        reason: reason ?? null,
      },
    });

    return { fromStatus, toStatus };
  }
}
