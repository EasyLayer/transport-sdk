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
import { WsBrowserConsumer, type WsBrowserOptions } from './ws';
import { HttpWebhookConsumer, type HttpWebhookOptions } from './http-webhook';

type TransportConfig = { type: 'ws'; options: WsBrowserOptions } | { type: 'http'; options: HttpWebhookOptions };

type SubscribeHandler<T = any> = (evt: T) => unknown | Promise<unknown>;

export interface ClientOptions {
  transport: Transport | TransportConfig;
}

/**
 * Browser Client
 * - Subscribe-only. Queries are not supported by browser transports.
 * - Registers handlers before connect(); auto-ACK after successful onRawBatch.
 * - Single-channel 'message' is enforced in transports.
 */
export class Client {
  private readonly t: Transport;
  private readonly caps: TransportCapabilities;

  private subs = new Map<string, Set<SubscribeHandler>>();
  private pending = new Map<string, (data: any) => void>(); // kept for API symmetry

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
        return new WsBrowserConsumer(cfg.options);
      case 'http':
        return new HttpWebhookConsumer(cfg.options);
      default:
        throw new Error('[client-browser] unknown transport type');
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
    // Browser transports do not deliver QueryResponse normally,
    // but we keep this for symmetry and potential future extensions.
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

  async query<TReq, TRes>(_requestId: string, _body: QueryRequestPayload<TReq>, _timeoutMs = 5_000): Promise<TRes> {
    // Browser consumer transports do not support queries by protocol.
    throw new Error('[client-browser] query is not supported by transport');
  }
}
