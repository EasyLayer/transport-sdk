import type { IncomingMessage } from './message.interface';

export type TransportType = 'http' | 'ipc' | 'ws';

export interface ITransport {
  readonly type: TransportType;
  readonly name: string;

  destroy(): Promise<void>;
  send(message: IncomingMessage): Promise<void>;
  sendAndAwait<R = any>(message: IncomingMessage): Promise<R>;
  subscribe<T = unknown>(constructorName: string, listener: (event: T) => Promise<void>): () => void;
  isConnected(): boolean;
  getSubscriptionCount(constructorName: string): number;
  getActiveSubscriptions(): string[];
}
