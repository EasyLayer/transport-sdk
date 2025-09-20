// Unified HTTP transport (no internal server).
// 1) RPC query via POST baseUrl + rpcPath.
// 2) Webhook forward: injectEnvelope(env) -> forward to forwardWebhook.url (expects ACK in HTTP response),
//    then optionally dispatch locally.
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
import { Actions, isAction, TRANSPORT_OVERHEAD_WIRE, utf8Len } from '../core/transport';

export interface HttpRpcOptions {
  baseUrl?: string;
  rpcPath?: string;

  ackPath?: string; // rarely used when not forwarding

  forwardWebhook?: {
    url: string;
    headers?: Record<string, string>;
    dispatchLocallyAfterAck?: boolean; // default true
  };

  fetchImpl?: typeof fetch;
  maxMessageBytes?: number;
  connectionTimeout?: number; // noop here
}

export class HttpRpcClient implements Transport {
  private connected = false;
  private rawBatchHandler: ((b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>) | null = null;
  private rawEnvelopeHandler?: (e: Envelope, ctx: BatchContext) => void;
  private readonly maxBytes: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly opts: HttpRpcOptions) {
    this.maxBytes = opts.maxMessageBytes ?? 1024 * 1024;
    this.fetcher = opts.fetchImpl ?? (globalThis as any).fetch;
    if (!this.fetcher) throw new Error('[http] fetch is not available; pass fetchImpl or polyfill globally');
  }

  kind() {
    return 'http' as const;
  }

  capabilities(): TransportCapabilities {
    return { canQuery: Boolean(this.opts.baseUrl && this.opts.rpcPath) };
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
  onRawEnvelope(h: (e: Envelope, ctx: BatchContext) => void) {
    this.rawEnvelopeHandler = h;
  }

  async ackOutbox(_p: OutboxStreamAckPayload): Promise<void> {
    // not used in HTTP client (ACK is returned by server in forward mode)
    return;
  }

  /** Forward/inject path for tests/bridges. */
  async injectEnvelope(env: Envelope, ctx?: BatchContext) {
    if (isAction(env.action as string, 'OutboxStreamBatch')) {
      // forward first (if configured)
      if (this.opts.forwardWebhook?.url) {
        const json = JSON.stringify(env);
        if (utf8Len(json) + TRANSPORT_OVERHEAD_WIRE > this.maxBytes)
          throw new Error('[http] forwarded batch too large');
        const res = await this.fetcher(this.opts.forwardWebhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.opts.forwardWebhook.headers ?? {}) },
          body: json,
        });
        if (!res.ok) throw new Error(`[http] forward webhook ${res.status}`);
        const ack = await res.json().catch(() => ({}));
        const ok = isAction(ack?.action, 'OutboxStreamAck');
        if (!ok) throw new Error('[http] forward webhook did not return OutboxStreamAck');
      }
      // then dispatch locally (default)
      if (this.rawBatchHandler && this.opts.forwardWebhook?.dispatchLocallyAfterAck !== false) {
        const style = (env.action as string).includes('outboxStreamBatch') ? 'camel' : 'dot';
        await this.rawBatchHandler(
          { ...(env.payload as OutboxStreamBatchPayload), _actionName: env.action as string },
          { ...(ctx ?? { transport: 'http' }), actionStyle: style }
        );
      }
      return;
    }

    if (isAction(env.action as string, 'QueryResponse') && this.rawEnvelopeHandler) {
      this.rawEnvelopeHandler(env, ctx ?? { transport: 'http' });
      return;
    }
  }

  /** RPC over HTTP: POST request/inline response. */
  async query<TReq, TRes>(requestId: string, body: QueryRequestPayload<TReq>): Promise<TRes> {
    if (!this.opts.baseUrl || !this.opts.rpcPath)
      throw new Error('[http] query not configured (baseUrl/rpcPath missing)');
    const env: Envelope<QueryRequestPayload<TReq>> = {
      action: Actions.QueryRequest,
      requestId,
      timestamp: Date.now(),
      payload: body,
    };
    const json = JSON.stringify(env);
    if (utf8Len(json) + TRANSPORT_OVERHEAD_WIRE > this.maxBytes) throw new Error('[http] message too large');

    const res = await this.fetcher(this.opts.baseUrl + this.opts.rpcPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
    });
    if (!res.ok) throw new Error(`[http] ${res.status}`);

    const respEnv = (await res.json()) as Envelope;
    if (isAction(respEnv.action as string, 'QueryResponse') && respEnv.requestId === requestId) {
      const p = respEnv.payload as any;
      if (p?.ok === false) throw new Error(String(p?.err ?? 'query failed'));
      return (p?.data ?? p?.payload) as TRes;
    }
    this.rawEnvelopeHandler?.(respEnv, { transport: 'http' });
    return undefined as unknown as TRes;
  }
}
