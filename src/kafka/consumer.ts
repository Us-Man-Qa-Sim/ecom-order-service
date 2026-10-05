import type { TypedEventEnvelope, TopicName } from '@us-man-qa-sim/ecom-contracts/events';

export interface TopicHandler<T extends TopicName = TopicName> {
  handle(event: TypedEventEnvelope<T>): Promise<void>;
}
