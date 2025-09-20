// Node WebSocket transport (socket.io-client), single 'message' channel.
// - Replies Pong on Ping; marks handshakeDone after Pong.
// - isConnectedSync() == true only when socket.connected && handshakeDone.
// - Supports query: ensureConnectedOrThrow() gates on handshake (Ping->Pong).
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
import { Actions, isAction, ackActionFor, TRANSPORT_OVERHEAD_WIRE, utf8Len } from '../core/transport';

export interface WsNodeOptions {
  url: string;
  path?: string; // default '/socket.io'
  transports?: ('websocket' | 'polling')[];
  token?: string;
  maxMessageBytes?: number; // for query sizing; ACK ignores size
  connectionTimeout?: number; // default 5000
}

export class WsNodeTransport implements Transport {
  private socket?: Socket;
  private rawBatchHandler: ((b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>) | null = null;
  private rawEnvelopeHandler?: (e: Envelope, ctx: BatchContext) => void;
  private handshakeDone = false;
  private readonly maxBytes: number;

  constructor(private readonly opts: WsNodeOptions) {
    this.maxBytes = opts.maxMessageBytes ?? 1024 * 1024;
  }

  kind() {
    return 'ws' as const;
  }
  capabilities(): TransportCapabilities {
    return { canQuery: true };
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
        () => reject(new Error('[ws-node] connection timeout')),
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
        reject(err || new Error('[ws-node] connect_error'));
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
    this.handshakeDone = false;
  }

  isConnectedSync(): boolean {
    return !!this.socket && this.socket.connected === true && this.handshakeDone;
  }

  async awaitConnected(timeoutMs = 5_000): Promise<boolean> {
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
  onRawEnvelope(h: (e: Envelope, ctx: BatchContext) => void) {
    this.rawEnvelopeHandler = h;
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
      this.handshakeDone = true; // mark ready for queries only after our Pong
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

    if (isAction(env.action as string, 'QueryResponse')) {
      this.rawEnvelopeHandler?.(env, ctx);
      return;
    }

    // ignore others
  }

  private async ensureConnectedOrThrow(): Promise<void> {
    const ok = await this.awaitConnected(this.opts.connectionTimeout ?? 5_000);
    if (!ok) throw new Error('[ws-node] not connected');
  }

  async ackOutbox(p: OutboxStreamAckPayload, ctx?: BatchContext): Promise<void> {
    // No size check for ACK.
    const env: Envelope<OutboxStreamAckPayload> = {
      action: ackActionFor(ctx?.actionStyle === 'camel' ? 'outboxStreamBatch' : Actions.OutboxStreamBatch),
      payload: p,
      timestamp: Date.now(),
    };
    this.socket?.emit('message', env);
  }

  async query<TReq, TRes>(requestId: string, body: QueryRequestPayload<TReq>): Promise<TRes> {
    await this.ensureConnectedOrThrow();
    const env: Envelope<QueryRequestPayload<TReq>> = {
      action: Actions.QueryRequest,
      requestId,
      timestamp: Date.now(),
      payload: body,
    };
    const json = JSON.stringify(env);
    if (utf8Len(json) + TRANSPORT_OVERHEAD_WIRE > this.maxBytes) {
      throw new Error('[ws-node] message too large');
    }
    this.socket?.emit('message', env);
    // response will arrive via onRawEnvelope -> Client pending map resolves
    return undefined as unknown as TRes;
  }
}
