export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000; // 5 min

/**
 * Generic payload envelope.
 */
export interface Payload<DTO = any> {
  /** Type name for routing on the other end. */
  constructorName: string;
  /** Actual data transfer object. */
  dto: DTO;
}

/**
 * Wire-format for messages exchanged over any transport.
 */
export interface Message<A extends string = string, P = Payload> {
  /** Correlation key for matching responses. */
  requestId?: string;
  action: A;
  payload: P;
}

/** Allowed client-initiated actions. */
export type OutgoingAction = 'query' | 'pong';

/** Allowed server-initiated or response actions. */
export type IncomingAction = 'queryResponse' | 'ping' | 'error' | 'event' | 'batch';

/** Supported transport protocols. */
export type TransportType = 'http' | 'ipc';

/**
 * Core transport interface: send-only,
 * send-and-await, subscribe, destroy.
 */
export interface ITransport {
  readonly type: TransportType;
  readonly name: string;
  destroy(): Promise<void>;
  send(message: Message): Promise<void>;
  sendAndAwait<R = any>(message: Message): Promise<R>;
  subscribe<T = unknown>(constructorName: string, listener: (event: T) => Promise<void>): () => void;
}

/**
 * Common logic for all transports.
 * - Manages subscriptions
 * - Implements sendAndAwait with timeout
 * - Handles ping/pong and event dispatch
 */
export abstract class BaseTransport implements ITransport {
  readonly type: TransportType;
  readonly name: string;

  // Map<messageType, Set<listeners>>
  private readonly subscriptions = new Map<string, Set<(e: any) => Promise<void>>>();

  protected constructor(type: TransportType, name: string) {
    this.type = type;
    this.name = name;
  }

  /** Transport-specific one-way send (no response expected). */
  protected abstract forward(message: Message): Promise<any>;

  /** Transport-specific send+await implementation. */
  protected abstract transmit(message: Message): Promise<any>;

  /**
   * Clean up resources (e.g. close sockets, child processes).
   */
  public async destroy(): Promise<void> {
    throw new Error('destroy() not implemented by this transport');
  }

  /**
   * Subscribe to incoming messages of a given constructorName.
   * Returns an unsubscribe function.
   */
  public subscribe<T>(constructorName: string, listener: (ev: T) => Promise<void>): () => void {
    const bucket = this.subscriptions.get(constructorName) ?? new Set();
    bucket.add(listener as any);
    this.subscriptions.set(constructorName, bucket);
    return () => bucket.delete(listener as any);
  }

  /** One-way send wrapper. */
  public async send(message: Message): Promise<void> {
    await this.forward(message);
  }

  /**
   * Send a message and wait for either its response or a timeout.
   * Defaults to 5-minute timeout.
   */
  public async sendAndAwait<R = any>(message: Message): Promise<R> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout waiting for response`)), DEFAULT_REQUEST_TIMEOUT_MS);
    });

    const transmitPromise = this.transmit(message) as Promise<R>;

    try {
      return await Promise.race<R>([transmitPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /**
   * Common handler for incoming messages:
   * - Replies to 'ping'
   * - Dispatches 'event'
   * - Returns payload for 'queryResponse', 'error', 'pong'
   */
  protected async handleMessage(message: Message): Promise<any> {
    switch (message.action) {
      case 'ping': {
        // automatic heartbeat reply
        return this.send({ ...message, action: 'pong', payload: {} as Payload });
      }
      case 'event': {
        // dispatch to all subscribers of this event type
        const { constructorName, dto } = message.payload as Payload;
        const listeners = this.subscriptions.get(constructorName) || [];
        for (let cb of listeners) {
          await cb(dto);
        }
        return;
      }
      case 'batch': {
        // dispatch to all subscribers of this events types
        const candidate = message.payload as Payload | Payload[];
        const payloads: Payload[] = Array.isArray(candidate) ? candidate : [candidate];

        for (const { constructorName, dto } of payloads) {
          const listeners = this.subscriptions.get(constructorName) || [];
          for (const cb of listeners) {
            await cb(dto);
          }
        }
        return;
      }
      case 'queryResponse':
      case 'error':
      case 'pong':
        // caller of transmit() will handle this
        return message;

      default:
      // console.warn(`[${this.name}] unexpected action "${message.action}"`);
    }
  }
}
