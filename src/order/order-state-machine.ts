import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { FailedPreconditionError, NotFoundError } from '../common/errors/domain-errors';

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

export interface LockedOrder {
  id: string;
  userId: string;
  status: OrderStatus;
}

export interface TransitionOptions {
  reason?: string;
  // Runs against the locked row before the transition is resolved — e.g. an
  // ownership check. Throwing aborts the transaction.
  authorize?: (order: LockedOrder) => void;
}

export interface TransitionResult {
  userId: string;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
}

@Injectable()
export class OrderStateMachine {
  // Must run inside the caller's transaction. The row is read with
  // `FOR UPDATE`, so two concurrent transitions on one order (admin ship vs
  // user cancel, or a KFK-4 stock result vs a cancel) serialise: the second
  // waits, then sees the committed status and fails FAILED_PRECONDITION
  // instead of both succeeding off the same stale read.
  async transition(
    tx: Prisma.TransactionClient,
    orderId: string,
    trigger: TransitionTrigger,
    options: TransitionOptions = {},
  ): Promise<TransitionResult> {
    const rows = await tx.$queryRaw<{ user_id: string; status: OrderStatus }[]>`
      SELECT user_id, status::text AS status
      FROM orders
      WHERE id = ${orderId}::uuid
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      throw new NotFoundError('Order not found');
    }

    const locked: LockedOrder = { id: orderId, userId: row.user_id, status: row.status };
    options.authorize?.(locked);

    const fromStatus = locked.status;
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
        reason: options.reason ?? null,
      },
    });

    return { userId: locked.userId, fromStatus, toStatus };
  }
}
