import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
import type {
  Transport,
  TransportOptions,
  Envelope,
  RegisterStreamConsumerPayload,
  RpcRequestPayload,
  RpcResponsePayload,
  OutboxStreamBatchPayload,
  OutboxStreamAckPayload,
  WireEventRecord,
  ExpIntervalController,
  BatchHandler,
  BatchContext,
} from '../shared';
import { Actions, uuid, TRANSPORT_OVERHEAD_WIRE, utf8Len, exponentialIntervalAsync } from '../shared';

export interface WsClientOptions extends TransportOptions {
  url: string; // e.g., "https://host:3001/"
  path?: string; // e.g., "/"
  transports?: ('websocket' | 'polling')[];
}

export class WsClientTransport implements Transport {
  private socket: Socket | null = null;
  private lastPong = 0;
  private heartbeatCtl: ExpIntervalController | null = null;

  private batchHandler: BatchHandler = async () => {};
  private readonly maxBytes: number;
  private readonly hbTimeout: number;
  private readonly connTimeout: number;
  private readonly token?: string;

  constructor(private readonly opts: WsClientOptions) {
    this.maxBytes = opts.maxMessageBytes ?? 1024 * 1024;
    this.hbTimeout = opts.heartbeatTimeout ?? 10000;
    this.connTimeout = opts.connectionTimeout ?? 5000;
    this.token = opts.token;
  }

  kind(): 'ws' {
    return 'ws';
  }

  async connect(): Promise<void> {
    if (this.socket) return;

    const url = this.opts.url;
    this.socket = io(url, {
      path: this.opts.path ?? '/',
      transports: this.opts.transports ?? ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      forceNew: true,
      timeout: this.connTimeout,
    });

    this.installHandlers(this.socket);

    // Wait up to connectionTimeout for 'connect'
    const ok = await this.awaitConnected(this.connTimeout);
    if (!ok) throw new Error('WS connect timeout');
    // Register as streaming consumer (business identity)
    await this.sendRegister();
    this.startHeartbeatLoop();
  }

  async disconnect(): Promise<void> {
    this.heartbeatCtl?.destroy();
    this.heartbeatCtl = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  isConnectedSync(): boolean {
    const s = this.socket;
    if (!s || !s.connected) return false;
    const age = Date.now() - this.lastPong;
    return age < this.hbTimeout;
  }

  async awaitConnected(timeoutMs: number = this.connTimeout): Promise<boolean> {
    if (this.isConnectedSync()) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isConnectedSync()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.isConnectedSync();
  }

  onBatch(handler: BatchHandler): void {
    this.batchHandler = handler || (async () => {});
  }

  async ackOutbox(payload: OutboxStreamAckPayload): Promise<void> {
    // WS ACK has no correlationId; server checks business-socket binding
    await this.send({ action: Actions.OutboxStreamAck, payload });
  }

  async query<TReq = unknown, TRes = unknown>(route: string, data?: TReq): Promise<TRes> {
    const correlationId = uuid();
    const env: Envelope<RpcRequestPayload> = {
      action: Actions.RpcRequest,
      correlationId,
      payload: { route, data },
      timestamp: Date.now(),
    };

    // TODO(perf): whole-envelope stringify will re-escape nested JSON (if data is JSON-string).
    const serialized = JSON.stringify(env);
    const size = utf8Len(serialized) + TRANSPORT_OVERHEAD_WIRE;
    if (size > this.maxBytes) throw new Error(`[ws] message too large: ${size} > ${this.maxBytes}`);

    const socket = this.socket;
    if (!socket) throw new Error('[ws] socket not initialized');
    if (!this.isConnectedSync()) throw new Error('[ws] not connected');

    return await new Promise<TRes>((resolve, reject) => {
      const onResp = (raw: any) => {
        let msg: Envelope<RpcResponsePayload>;
        try {
          msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          return;
        }
        if (msg.action === Actions.RpcResponse && msg.correlationId === correlationId) {
          socket!.off('message', onResp);
          if (msg.payload?.err) reject(new Error(String(msg.payload.err)));
          else resolve(msg.payload?.data as TRes);
        }
      };
      socket.on('message', onResp);
      socket.emit('message', serialized);
      // safety timeout on client side
      setTimeout(() => {
        socket.off('message', onResp);
        reject(new Error('[ws] RPC timeout'));
      }, this.connTimeout);
    });
  }

  // ==== internals ====

  private installHandlers(s: Socket) {
    s.on('connect', () => {
      /* fine */
    });
    s.on('disconnect', () => {
      /* socket.io manages reconnects */
    });

    s.on('message', async (raw: any) => {
      let msg: Envelope<any>;
      try {
        msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        return;
      }

      switch (msg.action) {
        case Actions.Ping: {
          this.lastPong = Date.now(); // we treat ping as a sign of life as well
          const pong: Envelope = { action: Actions.Pong, payload: { ts: Date.now() }, timestamp: Date.now() };
          s.emit('message', JSON.stringify(pong));
          return;
        }
        case Actions.Pong: {
          this.lastPong = Date.now();
          return;
        }
        case Actions.OutboxStreamBatch: {
          // WS batches do NOT carry correlationId; ACK will be plain
          const p = (msg.payload || {}) as OutboxStreamBatchPayload;
          const events: WireEventRecord[] = Array.isArray(p.events) ? p.events : [];
          const ctx: BatchContext = {};
          await this.batchHandler(events, ctx);
          return;
        }
        default:
          return;
      }
    });
  }

  private startHeartbeatLoop() {
    if (this.heartbeatCtl) return;
    // Client-side: keep a light loop that sends ping if we think we're online
    this.heartbeatCtl = exponentialIntervalAsync(
      async (reset) => {
        // If server pings us, we just need to keep 'lastPong' fresh. Still, send a ping sometimes.
        const s = this.socket;
        if (!s || !s.connected) return;
        const ping: Envelope = { action: Actions.Ping, payload: { ts: Date.now() }, timestamp: Date.now() };
        s.emit('message', JSON.stringify(ping));
        // If we recently saw a pong, reset backoff
        if (this.isConnectedSync()) reset();
      },
      { interval: Math.max(500, Math.floor(this.hbTimeout / 2)), multiplier: 2, maxInterval: this.hbTimeout }
    );
  }

  private async sendRegister(): Promise<void> {
    const s = this.socket;
    if (!s) return;
    const payload: RegisterStreamConsumerPayload = { token: this.token };
    const msg: Envelope<RegisterStreamConsumerPayload> = {
      action: Actions.RegisterStreamConsumer,
      payload,
      timestamp: Date.now(),
    };
    s.emit('message', JSON.stringify(msg));
  }

  private async send<T = unknown>(env: Envelope<T>) {
    const s = this.socket;
    if (!s) throw new Error('[ws] socket not initialized');
    // TODO(perf): see top-level note about re-escaping of large nested JSON
    const serialized = JSON.stringify(env);
    const size = utf8Len(serialized) + TRANSPORT_OVERHEAD_WIRE;
    if (size > this.maxBytes) throw new Error(`[ws] message too large: ${size} > ${this.maxBytes}`);
    s.emit('message', serialized);
  }
}
