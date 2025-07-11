import type { BasePayload, ErrorPayload, IncomingMessage, OutgoingMessage, TransportType, ITransport } from '../shared';
import {
  TransportError,
  MessageError,
  TimeoutError,
  SubscriptionError,
  ErrorUtils,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../shared';

export interface BaseTransportOptions {
  timeout?: number;
  name?: string;
}

export abstract class BaseTransport implements ITransport {
  readonly type: TransportType;
  readonly name: string;
  protected readonly timeout: number;

  private readonly subscriptions = new Map<string, Set<(e: any) => Promise<void>>>();
  protected connectionMutex = false;

  protected constructor(type: TransportType, name: string, options?: BaseTransportOptions) {
    this.type = type;
    this.name = name;
    this.timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  protected abstract forward(message: IncomingMessage): Promise<void>;
  protected abstract transmit(message: IncomingMessage): Promise<any>;
  public abstract isConnected(): boolean;

  public async destroy(): Promise<void> {
    throw new TransportError('destroy() not implemented by this transport', 'NOT_IMPLEMENTED', {
      transportType: this.type,
      transportName: this.name,
    });
  }

  public subscribe<T>(constructorName: string, listener: (ev: T) => Promise<void>): () => void {
    if (typeof constructorName !== 'string' || !constructorName.trim()) {
      throw new SubscriptionError('constructorName must be a non-empty string', {
        transportType: this.type,
        transportName: this.name,
        context: { receivedType: typeof constructorName },
      });
    }
    if (typeof listener !== 'function') {
      throw new SubscriptionError('listener must be a function', {
        transportType: this.type,
        transportName: this.name,
        constructorName,
        context: { expectedType: 'function', receivedType: typeof listener },
      });
    }

    const bucket = this.subscriptions.get(constructorName) ?? new Set();
    bucket.add(listener as any);
    this.subscriptions.set(constructorName, bucket);

    return () => {
      bucket.delete(listener as any);
      if (bucket.size === 0) {
        this.subscriptions.delete(constructorName);
      }
    };
  }

  public async send(message: IncomingMessage): Promise<void> {
    this.validateMessage(message);
    await this.forward(message);
  }

  public async sendAndAwait<R = any>(message: IncomingMessage): Promise<R> {
    this.validateMessage(message);

    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new TimeoutError(`Timeout waiting for response to ${message.action} after ${this.timeout}ms`, this.timeout, {
            transportType: this.type,
            transportName: this.name,
            action: message.action,
            requestId: message.requestId,
          })
        );
      }, this.timeout);
    });

    const transmitPromise = this.transmit(message);

    try {
      const result = await Promise.race([transmitPromise, timeoutPromise]);

      if (result === undefined || result === null) {
        throw new MessageError(`Received empty response for ${message.action}`, {
          transportType: this.type,
          transportName: this.name,
          context: { action: message.action, requestId: message.requestId },
        });
      }

      return result as R;
    } finally {
      clearTimeout(timer!);
    }
  }

  private validateMessage(message: IncomingMessage): void {
    if (!message || typeof message.action !== 'string') {
      throw new MessageError('Invalid message: action is required', {
        transportType: this.type,
        transportName: this.name,
        messageData: message,
      });
    }
  }

  protected async handleMessage(message: OutgoingMessage): Promise<any> {
    if (!message || typeof message.action !== 'string') {
      return;
    }

    switch (message.action) {
      case 'ping': {
        await this.send({
          ...message,
          action: 'pong',
          payload: { constructorName: 'pong', dto: {} } as BasePayload,
        });
        return;
      }

      case 'event': {
        const payload = message.payload as BasePayload;
        if (!payload?.constructorName) {
          return;
        }

        const listeners = this.subscriptions.get(payload.constructorName) || [];
        await Promise.allSettled(Array.from(listeners).map((cb) => cb(payload.dto)));
        return;
      }

      case 'eventsBatch': {
        const candidate = message.payload as BasePayload | BasePayload[];
        const payloads: BasePayload[] = Array.isArray(candidate) ? candidate : [candidate];

        for (const payload of payloads) {
          if (!payload?.constructorName) {
            continue;
          }

          const listeners = this.subscriptions.get(payload.constructorName) || [];
          await Promise.allSettled(Array.from(listeners).map((cb) => cb(payload.dto)));
        }
        return;
      }

      case 'queryResponse': {
        return message.payload;
      }

      case 'streamResponse': {
        return message.payload;
      }

      case 'streamEnd': {
        return { ended: true };
      }

      case 'error': {
        const errorPayload = message.payload as ErrorPayload;
        throw ErrorUtils.fromErrorPayload(errorPayload, {
          type: this.type,
          name: this.name,
        });
      }

      case 'pong': {
        return message;
      }

      default:
        return;
    }
  }

  protected async ensureConnection(): Promise<void> {
    if (this.isConnected()) return;

    if (this.connectionMutex) {
      while (this.connectionMutex && !this.isConnected()) {
        await new Promise((r) => setTimeout(r, 10));
      }
      if (this.isConnected()) return;
    }
  }

  public getSubscriptionCount(constructorName: string): number {
    return this.subscriptions.get(constructorName)?.size ?? 0;
  }

  public getActiveSubscriptions(): string[] {
    return Array.from(this.subscriptions.keys());
  }
}
