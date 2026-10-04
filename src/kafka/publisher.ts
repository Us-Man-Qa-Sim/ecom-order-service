export interface OutboundMessage {
  topic: string;
  key: string;
  value: string;
  headers?: Record<string, string>;
}

export interface Publisher {
  publish(message: OutboundMessage): Promise<void>;
}

export const PUBLISHER = Symbol('Publisher');
