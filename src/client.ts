import type { TransportOptions } from './core/factory';
import { TransportFactory } from './core/factory';
import type { ITransport, Payload, OutgoingAction, Message } from './core/transport';

/**
 * ClientOptions passed to the SDK.
 */
export interface ClientOptions {
  /** Transport configuration (e.g. RPC or IPC). */
  transport: TransportOptions;
}

/**
 * Main SDK entry point.
 */
export class Client {
  private _transport: ITransport;

  /**
   * Initializes the client and its underlying transport.
   * @param options Configuration including transport type/options.
   */
  constructor(options: ClientOptions) {
    this._transport = TransportFactory.create(options.transport);

    // Ensure graceful shutdown
    const shutdown = () => this._transport.destroy().catch(console.error);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  /** Expose the raw transport for advanced use. */
  get transport(): ITransport {
    return this._transport;
  }

  /**
   * Sends a request and awaits its response.
   * @param action Must be 'query' for now.
   * @param requestId Unique identifier for correlation.
   * @param payload Arbitrary payload data.
   * @returns The deserialized response of type T.
   */
  async request<T = any>(action: OutgoingAction, requestId: string, payload: Payload): Promise<T> {
    if (!requestId) {
      throw new Error('requestId is required.');
    }

    switch (action) {
      case 'query': {
        const message: Message = { action, requestId, payload };
        return await this.transport.sendAndAwait<T>(message);
      }
      default: {
        throw new Error(`Unsupported action: ${action}`);
      }
    }
  }

  /**
   * Subscribe to messages of a given type.
   * @param constructorName The message type key to listen for.
   * @param cb Async callback invoked for each message.
   * @returns Unsubscribe function.
   */
  subscribe<T = any>(constructorName: string, cb: (event: T) => Promise<void>): () => void {
    return this.transport.subscribe(constructorName, cb);
  }
}
