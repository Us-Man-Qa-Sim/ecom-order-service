import { FailedPreconditionError } from '../../common/errors/domain-errors';
import type { TransitionResult } from '../../order/order-state-machine';

// KFK-7 (order side): a stock result can arrive for an order that has already
// left PENDING — typically the user cancelled while product-service was
// reserving. The state machine rejects that transition with
// FailedPreconditionError. That is an expected race, not a failure: return
// null so the caller commits the inbox row and moves on, instead of throwing
// into the consumer's retry loop and ending up logged as a poison message.
// Stock stays consistent because product-service also consumes the
// order.cancelled that the cancel emitted and releases any reservation.
//
// The rejection is raised in JS after the `SELECT … FOR UPDATE` succeeded, so
// the surrounding Postgres transaction is still usable.
export async function applyIfPending(
  transition: () => Promise<TransitionResult>,
): Promise<TransitionResult | null> {
  try {
    return await transition();
  } catch (err) {
    if (err instanceof FailedPreconditionError) return null;
    throw err;
  }
}
