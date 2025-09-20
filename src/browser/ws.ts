// Browser-only WebSocket consumer using socket.io-client, single 'message' channel.
// - Subscribe-only: routes OutboxStreamBatch to Client (which will auto-ACK via ackOutbox).
// - Replies Pong on Ping (SDK never initiates Ping).
// - No query support in browser.
//
// Time: O(1) per message; Space: O(1).

import { io, type Socket } from 'socket.io-client';
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

export interface WsBrowserOptions {
  url: string;
  path?: string;
  transports?: ('websocket' | 'polling')[];
  token?: string;
  maxMessageBytes?: number; // kept for parity; not used for ACK sizing
  connectionTimeout?: number;
}

export class WsBrowserConsumer implements Transport {
  private socket?: Socket;
  private rawBatchHandler: ((b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>) | null = null;

  constructor(private readonly opts: WsBrowserOptions) {}

  kind() {
    return 'ws' as const;
  }
  capabilities(): TransportCapabilities {
    return { canQuery: false };
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    const s = (this.socket = io(this.opts.url.replace(/\/+$/, ''), {
      path: this.opts.path ?? '/socket.io',
      transports: this.opts.transports ?? ['websocket', 'polling'],
      auth: this.opts.token ? { token: this.opts.token } : undefined,
      autoConnect: false,
    }));

    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(
        () => reject(new Error('[ws-browser] connection timeout')),
        this.opts.connectionTimeout ?? 5_000
      );

      const onMessage = (data: any) => {
        const env: Envelope = typeof data === 'string' ? JSON.parse(data) : data;
        void this.route(env, { transport: 'ws', raw: s });
      };

      s.on('message', onMessage);
      s.once('connect', () => {
        clearTimeout(to);
        resolve();
      });
      s.once('connect_error', (err) => {
        clearTimeout(to);
        reject(err || new Error('[ws-browser] connect_error'));
      });
      s.connect();
    });
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.off('message');
      this.socket.disconnect();
      this.socket = undefined;
    }
  }

  isConnectedSync(): boolean {
    return !!this.socket && this.socket.connected === true;
  }

  async awaitConnected(timeoutMs = 5_000): Promise<boolean> {
    if (this.isConnectedSync()) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isConnectedSync()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.isConnectedSync();
  }

  onRawBatch(h: (b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>) {
    this.rawBatchHandler = h;
  }

  private async route(env: Envelope, ctx: BatchContext) {
    if (isAction(env.action as string, 'Ping')) {
      const p: any = env.payload || {};
      const pong: Envelope = {
        action: Actions.Pong,
        timestamp: Date.now(),
        payload: { ts: p.ts ?? Date.now(), nonce: p.nonce, sid: p.sid },
      };
      this.socket?.emit('message', pong);
      return;
    }

    if (isAction(env.action as string, 'OutboxStreamBatch')) {
      if (!this.rawBatchHandler) return;
      const style = (env.action as string).includes('outboxStreamBatch') ? 'camel' : 'dot';
      await this.rawBatchHandler(
        { ...(env.payload as OutboxStreamBatchPayload), _actionName: env.action as string },
        { ...ctx, actionStyle: style }
      );
      return;
    }

    // Forward any other envelopes to optional handler (browser usually doesn't need it)
    // (No onRawEnvelope in browser consumer)
  }

  async ackOutbox(p: OutboxStreamAckPayload, ctx?: BatchContext): Promise<void> {
    // No size check for ACK, per requirement.
    const env: Envelope<OutboxStreamAckPayload> = {
      action: ackActionFor(ctx?.actionStyle === 'camel' ? 'outboxStreamBatch' : Actions.OutboxStreamBatch),
      payload: p,
      timestamp: Date.now(),
    };
    this.socket?.emit('message', env);
  }

  async query<TReq, TRes>(_rid: string, _b: QueryRequestPayload<TReq>): Promise<TRes> {
    throw new Error('[ws-browser] query is not supported in browser consumer');
  }
}
