import type { ClientTransportOptions } from './core/factory';
import { TransportFactory } from './core/factory';
import { MessageError } from './shared';
import type { ITransport, BasePayload, IncomingMessage } from './shared';

export interface ClientOptions {
  transport: ClientTransportOptions;
}

export class Client {
  private _transport: ITransport;

  constructor(options: ClientOptions) {
    this._transport = TransportFactory.create(options.transport);

    // Setup graceful shutdown
    const shutdown = () =>
      this._transport.destroy().catch(() => {
        // Silently handle shutdown errors
      });

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  get transport(): ITransport {
    return this._transport;
  }

  /**
   * Execute a query and wait for response
   */
  public async query<T = any>(requestId: string, payload: BasePayload): Promise<T> {
    if (!requestId) {
      throw new MessageError('requestId is required', {
        transportType: this.transport.type,
        transportName: this.transport.name,
        context: { payload },
      });
    }

    const message: IncomingMessage = {
      action: 'query',
      requestId,
      payload,
      timestamp: Date.now(),
    };

    return await this.transport.sendAndAwait<T>(message);
  }

  /**
   * Execute a streaming query (for transports that support it)
   */
  public async *streamQuery<T = any>(requestId: string, payload: BasePayload): AsyncGenerator<T, void, unknown> {
    if (!requestId) {
      throw new MessageError('requestId is required', {
        transportType: this.transport.type,
        transportName: this.transport.name,
        context: { payload },
      });
    }

    const message: IncomingMessage = {
      action: 'streamQuery',
      requestId,
      payload,
      timestamp: Date.now(),
    };

    // For streaming, we need to handle multiple responses
    const result = await this.transport.sendAndAwait<T[] | T>(message);

    // Convert array to async generator
    if (Array.isArray(result)) {
      for (const item of result) {
        yield item;
      }
    } else {
      yield result;
    }
  }

  /**
   * Subscribe to events by constructor name
   */
  public subscribe<T = any>(constructorName: string, cb: (event: T) => Promise<void>): () => void {
    return this.transport.subscribe(constructorName, cb);
  }

  /**
   * Check if transport is connected
   */
  public isConnected(): boolean {
    return this.transport.isConnected();
  }

  /**
   * Get number of active subscriptions for a specific event type
   */
  public getSubscriptionCount(constructorName: string): number {
    return this.transport.getSubscriptionCount(constructorName);
  }

  /**
   * Get all active subscription names
   */
  public getActiveSubscriptions(): string[] {
    return this.transport.getActiveSubscriptions();
  }

  /**
   * Destroy the client and cleanup resources
   */
  public async destroy(): Promise<void> {
    await this.transport.destroy();
  }
}
