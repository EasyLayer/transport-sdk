// Browser-only "webhook" consumer transport.
// External code must deliver envelopes via injectEnvelope(...).
// We reply Pong on Ping; deliver OutboxStreamBatch to Client; ACK via emit() or POST ackUrl.
// ACK messages do not check size.
//
// Time: O(1) per message; Space: O(1).

import type {
  Transport,
  TransportCapabilities,
  Envelope,
  BatchContext,
  OutboxStreamBatchPayload,
  OutboxStreamAckPayload,
  QueryRequestPayload,
} from '../core/transport';
import { Actions, isAction, ackActionFor } from '../core/transport';

export interface HttpWebhookOptions {
  ackUrl?: string;
  pongUrl?: string;
  emit?: (env: Envelope) => void | Promise<void>;
  fetchImpl?: typeof fetch;
  maxMessageBytes?: number; // kept for parity; not used for ACK sizing
}

export class HttpWebhookConsumer implements Transport {
  private connected = false;
  private rawBatchHandler: ((b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>) | null = null;
  private readonly fetcher: typeof fetch;

  constructor(private readonly opts: HttpWebhookOptions = {}) {
    this.fetcher = opts.fetchImpl ?? (globalThis as any).fetch;
    if (!this.fetcher && !opts.emit) {
      throw new Error('[http-webhook] fetch is not available; provide fetchImpl or emit');
    }
  }

  kind() {
    return 'http' as const;
  }
  capabilities(): TransportCapabilities {
    return { canQuery: false };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  isConnectedSync(): boolean {
    return this.connected;
  }
  async awaitConnected(): Promise<boolean> {
    return this.connected;
  }
  onRawBatch(h: (b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>) {
    this.rawBatchHandler = h;
  }

  async injectEnvelope(env: Envelope, ctx?: BatchContext) {
    const baseCtx: BatchContext = ctx ?? { transport: 'http' };

    if (isAction(env.action as string, 'Ping')) {
      const pong: Envelope = {
        action: Actions.Pong,
        timestamp: Date.now(),
        payload: {
          ts: (env as any)?.payload?.ts ?? Date.now(),
          nonce: (env as any)?.payload?.nonce,
          sid: (env as any)?.payload?.sid,
        },
      };
      await this.sendOut(pong, this.opts.pongUrl);
      return;
    }

    if (isAction(env.action as string, 'OutboxStreamBatch')) {
      if (this.rawBatchHandler) {
        const style = (env.action as string).includes('outboxStreamBatch') ? 'camel' : 'dot';
        await this.rawBatchHandler(
          { ...(env.payload as OutboxStreamBatchPayload), _actionName: env.action as string },
          { ...baseCtx, actionStyle: style }
        );
      }
      return;
    }

    // If external system injects a QueryResponse (unlikely in browser), we ignore by default.
  }

  async ackOutbox(p: OutboxStreamAckPayload, ctx?: BatchContext): Promise<void> {
    const env: Envelope<OutboxStreamAckPayload> = {
      action: ackActionFor(ctx?.actionStyle === 'camel' ? 'outboxStreamBatch' : Actions.OutboxStreamBatch),
      payload: p,
      timestamp: Date.now(),
    };
    await this.sendOut(env, this.opts.ackUrl);
  }

  async query<TReq, TRes>(_rid: string, _b: QueryRequestPayload<TReq>): Promise<TRes> {
    throw new Error('[http-webhook] query is not supported in browser consumer');
  }

  private async sendOut(env: Envelope, postUrl?: string) {
    if (this.opts.emit) {
      await this.opts.emit(env);
      return;
    }
    if (postUrl && this.fetcher) {
      const res = await this.fetcher(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(env),
      });
      if (!res.ok) throw new Error(`[http-webhook] POST ${postUrl} failed with ${res.status}`);
    }
  }
}
