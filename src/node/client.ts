import type {
  Transport,
  TransportCapabilities,
  OutboxStreamBatchPayload,
  OutboxStreamAckPayload,
  Envelope,
  QueryResponsePayload,
  QueryRequestPayload,
} from '../core/transport';
import { isAction, uuid } from '../core/transport';
import { createDomainEventFromWire } from '../core/domain-event';
import { WsNodeTransport, type WsNodeOptions } from './ws';
import { IpcParentTransport, type IpcParentOptions } from './ipc-parent';
import { HttpRpcClient, type HttpRpcOptions } from './http';

type TransportConfig =
  | { type: 'ws'; options: WsNodeOptions }
  | { type: 'ipc-parent'; options: IpcParentOptions }
  | { type: 'http'; options: HttpRpcOptions };

type SubscribeHandler<T = any> = (evt: T) => unknown | Promise<unknown>;

export interface ClientOptions {
  transport: Transport | TransportConfig;
}

/**
 * Node Client
 * - Supports queries (gated by transport handshake: Ping->Pong).
 * - Registers handlers before connect(); auto-ACK after successful onRawBatch.
 * - Single-channel 'message' is enforced in transports.
 */
export class Client {
  private readonly t: Transport;
  private readonly caps: TransportCapabilities;

  private subs = new Map<string, Set<SubscribeHandler>>();
  private pending = new Map<string, (data: any) => void>();

  constructor(opts: ClientOptions) {
    this.t =
      typeof (opts.transport as any).kind === 'function'
        ? (opts.transport as Transport)
        : this.makeTransport(opts.transport as TransportConfig);

    this.caps = this.t.capabilities();

    // Register handlers BEFORE connect to avoid races.
    this.t.onRawBatch(async (batch, ctx) => {
      await this.t.ackOutbox(this.buildAck(batch), ctx);
      await this.dispatchBatch(batch);
    });

    if (this.t.onRawEnvelope) {
      this.t.onRawEnvelope((env) => this.routeRawEnvelope(env));
    }

    // Fire-and-forget connect.
    void this.t.connect();
  }

  async close(): Promise<void> {
    // Ensure transport disconnects and removes listeners/sockets
    await this.t.disconnect();
    // Clear pending resolvers to avoid leaks
    this.pending.clear();
    this.subs.clear();
  }

  private makeTransport(cfg: TransportConfig): Transport {
    switch (cfg.type) {
      case 'ws':
        return new WsNodeTransport(cfg.options);
      case 'ipc-parent':
        return new IpcParentTransport(cfg.options);
      case 'http':
        return new HttpRpcClient(cfg.options);
      default:
        throw new Error('[client-node] unknown transport type');
    }
  }

  private buildAck(b: OutboxStreamBatchPayload): OutboxStreamAckPayload {
    return { ackFromOffset: b.fromOffset, ackToOffset: b.toOffset, streamId: b.streamId };
  }

  private async dispatchBatch(batch: OutboxStreamBatchPayload) {
    for (const wire of batch.events) {
      const ctorName = wire.eventType || wire.type || 'UnknownEvent';
      const set = this.subs.get(ctorName);
      if (!set?.size) continue;

      const evt = createDomainEventFromWire(wire);
      for (const h of set) {
        await h(evt);
      }
    }
  }

  private routeRawEnvelope(env: Envelope) {
    if (isAction(env.action as string, 'QueryResponse') && env.requestId) {
      const resolver = this.pending.get(env.requestId);
      if (resolver) {
        const payload = env.payload as QueryResponsePayload<any>;
        this.pending.delete(env.requestId);
        if (payload?.ok === false) throw new Error(String(payload.err ?? 'query failed'));
        resolver(payload?.data ?? (payload as any)?.payload);
      }
    }
  }

  // PUBLIC API

  subscribe<T = any>(constructorName: string, handler: SubscribeHandler<T>): () => void {
    const set = this.subs.get(constructorName) ?? new Set();
    set.add(handler as any);
    this.subs.set(constructorName, set);
    return () => set.delete(handler as any);
  }

  getSubscriptionCount(constructorName: string): number {
    return this.subs.get(constructorName)?.size ?? 0;
  }

  /**
   * Send a query and resolve by QueryResponse (WS/IPC) or inline HTTP reply.
   * If transport returns undefined, wait for onRawEnvelope to resolve (with timeout).
   */
  async query<TReq, TRes>(requestId: string, body: QueryRequestPayload<TReq>, timeoutMs = 5_000): Promise<TRes> {
    if (!this.caps.canQuery || !this.t.query) {
      throw new Error('[client-node] query is not supported by transport');
    }

    let resolveFn!: (v: any) => void;
    const p = new Promise<TRes>((resolve) => {
      resolveFn = resolve;
    });
    this.pending.set(requestId, resolveFn);

    const inline = await this.t.query<TReq, TRes>(requestId, body);
    if (inline !== undefined) {
      this.pending.delete(requestId);
      return inline;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.pending.has(requestId)) {
        return await p;
      }

      await new Promise((r) => setTimeout(r, 20));
    }
    this.pending.delete(requestId);
    throw new Error('[client-node] query timeout');
  }

  /** Convenience helper that generates a requestId internally. */
  async querySimple<TReq, TRes>(constructorName: string, dto?: TReq, timeoutMs = 5_000): Promise<TRes> {
    const rid = uuid();
    return this.query<TReq, TRes>(rid, { constructorName, dto }, timeoutMs);
  }
}
