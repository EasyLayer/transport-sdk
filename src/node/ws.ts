import type { Message, OutboxStreamAckPayload, OutboxStreamBatchPayload, QueryRequestPayload } from '../core';
import { Actions, createDomainEventFromWire } from '../core';
import { normalize, computeBackoff, delay, nextBackoff } from '../core';

/**
 * WsClient
 * -----------------------------------------------------------------------------
 * Role:
 * - Owns a WebSocket client connection to the server (ws/wss URL), OR can attach
 *   to an externally created socket (via `attach()`), so the host app can manage
 *   the socket lifecycle itself.
 *
 * Inbound:
 * - 'ping'                 -> reply 'pong' with optional { password }.
 * - 'outbox.stream.batch'  -> fan-out events to subscribers by eventType,
 *                             then send 'outbox.stream.ack' with { ok, okIndices }.
 * - 'query.response'       -> resolve pending promise by requestId.
 * - Custom messages        -> available via `tapRaw()` and `onAction(action, handler)`.
 *
 * Outbound:
 * - 'query.request'        -> send with requestId and payload { name, data }.
 * - `sendRaw(frame)`       -> send any envelope/string as-is for custom protocols.
 *
 * Reliability:
 * - Optional auto-reconnect with backoff (disabled by default). When enabled,
 *   will reopen the socket after 'close'/'error' using exponential backoff.
 *
 * Cleanup:
 * - `close()` stops reconnects, removes handlers, and closes the socket.
 */
export class WsClient {
  private socket?: WebSocketLike;
  private url?: string;

  private reconnect?: { min: number; max: number; factor: number; jitter: number; enabled: boolean };
  private reconnectTimer?: NodeJS.Timeout;
  private closedManually = false;

  private subs = new Map<string, Set<(evt: any) => unknown | Promise<unknown>>>();
  private pendingQueries = new Map<string, (payload: any) => void>();

  private rawHandlers = new Set<(m: Message) => void>();
  private actionHandlers = new Map<string, Set<(m: Message) => void>>();

  constructor(
    private readonly opts: {
      /** ws:// or wss:// URL. Required if you do not call attach(). */
      url?: string;
      /** If provided, will be included in Pong payload as { password }. */
      pongPassword?: string;
      /** Optional headers for Node 'ws' constructor. Ignored in browsers. */
      headers?: Record<string, string>;
      /** Optional custom WebSocket constructor (e.g., global WebSocket in browser). */
      WebSocketCtor?: WebSocketCtor;
      /** Auto-reconnect settings (disabled by default). */
      reconnect?: { minMs?: number; maxMs?: number; factor?: number; jitter?: number; enabled?: boolean };
    }
  ) {
    this.url = opts?.url;
    const r = opts?.reconnect ?? {};
    this.reconnect = {
      min: Math.max(100, r.minMs ?? 500),
      max: Math.max(1000, r.maxMs ?? 5000),
      factor: Math.max(1.1, r.factor ?? 1.6),
      jitter: Math.max(0, r.jitter ?? 0.2),
      enabled: !!r.enabled,
    };
  }

  // -----------------------------------------------------------------------------
  // Public API — usage examples:
  // -----------------------------------------------------------------------------
  // Managed mode:
  //   const c = new WsClient({ url: 'wss://host:8443', pongPassword: 'pw', reconnect: { enabled: true } });
  //   await c.connect();
  //
  // Attached mode:
  //   const sock = new WebSocket('wss://host:8443');
  //   const c = new WsClient({ pongPassword: 'pw' });
  //   c.attach(sock);
  //
  // Custom messages:
  //   const off1 = c.tapRaw((m) => console.log('raw', m.action));
  //   const off2 = c.onAction('custom.message', (m) => console.log(m.payload));
  //   await c.sendRaw({ action: 'custom.request', payload: { x: 1 } });

  // ---------------------------------------------------------------------------
  // Subscription API
  // ---------------------------------------------------------------------------

  subscribe<T = any>(constructorName: string, handler: (evt: T) => unknown | Promise<unknown>): () => void {
    const set = this.subs.get(constructorName) ?? new Set();
    set.add(handler as any);
    this.subs.set(constructorName, set);
    return () => set.delete(handler as any);
  }

  getSubscriptionCount(constructorName: string): number {
    return this.subs.get(constructorName)?.size ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Extensibility hooks for custom messages
  // ---------------------------------------------------------------------------

  /** Register a raw envelope interceptor; runs BEFORE built-in routing. */
  tapRaw(handler: (msg: Message) => void): () => void {
    this.rawHandlers.add(handler);
    return () => this.rawHandlers.delete(handler);
  }

  /** Register a handler for a specific action (e.g., "custom.message"). */
  onAction(action: string, handler: (msg: Message) => void): () => void {
    const set = this.actionHandlers.get(action) ?? new Set<(m: Message) => void>();
    set.add(handler);
    this.actionHandlers.set(action, set);
    return () => set.delete(handler);
  }

  /** Send any JSON-able envelope or string as-is. */
  async sendRaw(frame: Message | string): Promise<void> {
    await this.send(frame);
  }

  // ---------------------------------------------------------------------------
  // Socket lifecycle
  // ---------------------------------------------------------------------------

  /** Create and open an internal WebSocket connection. */
  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === this.socket.OPEN) return;
    if (!this.url) throw new Error('[client-ws] url is required (or use attach())');

    const ctor = this.opts.WebSocketCtor ?? getNodeWsCtor();
    const ws = new ctor(this.url, undefined, { headers: this.opts.headers });
    this.bind(ws);
  }

  /** Attach to an already open or opening WebSocket created by the host app. */
  attach(socket: WebSocketLike): void {
    this.bind(socket);
  }

  /* eslint-disable no-empty */
  /** Close and cleanup. Disables auto-reconnect. */
  async close(): Promise<void> {
    this.closedManually = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket && this.socket.readyState === this.socket.OPEN) {
      try {
        this.socket.close();
      } catch {}
    }
    this.socket = undefined;
    this.pendingQueries.clear();
    this.subs.clear();
    this.rawHandlers.clear();
    this.actionHandlers.clear();
  }
  /* eslint-enable no-empty */

  /* eslint-disable no-empty */
  private bind(ws: WebSocketLike) {
    if (this.socket && this.socket !== ws) {
      try {
        this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null as any;
      } catch {}
    }

    this.socket = ws;
    this.closedManually = false;

    ws.onopen = () => {
      /* server will drive ping->pong */
    };
    ws.onmessage = (ev: { data: any }) => this.handleIncoming(ev.data);
    ws.onclose = () => this.onClosed();
    ws.onerror = () => {
      /* swallow, onclose handles flow */
    };
  }
  /* eslint-enable no-empty */

  private onClosed() {
    if (this.closedManually) return;
    if (!this.reconnect?.enabled || !this.url) return;

    const next = computeBackoff(this.reconnect!);
    this.reconnectTimer = setTimeout(() => {
      this.reconnect!.min = Math.min(this.reconnect!.max, this.reconnect!.min * this.reconnect!.factor);
      void this.connect();
    }, next);
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  /* eslint-disable no-empty */
  private async handleIncoming(raw: unknown) {
    const msg = normalize(raw);
    if (!msg?.action) return;

    // User raw taps first
    for (const h of this.rawHandlers) {
      try {
        h(msg);
      } catch {}
    }

    // User action handlers next
    const ah = this.actionHandlers.get(msg.action);
    if (ah?.size) {
      for (const h of ah) {
        try {
          h(msg);
        } catch {}
      }
    }

    switch (msg.action) {
      case Actions.Ping: {
        const pong: Message<{ password?: string }> = {
          action: Actions.Pong,
          payload: this.opts.pongPassword ? { password: this.opts.pongPassword } : undefined,
          timestamp: Date.now(),
        };
        this.send(pong).catch(() => {});
        return;
      }

      case Actions.OutboxStreamBatch: {
        const p = msg.payload as OutboxStreamBatchPayload;
        if (!p || !Array.isArray(p.events)) return;

        for (const wire of p.events) {
          const set = this.subs.get(wire.eventType || 'UnknownEvent');
          if (!set?.size) continue;
          const evt = createDomainEventFromWire(wire);
          for (const h of set) await h(evt);
        }

        const ack: Message<OutboxStreamAckPayload> = {
          action: Actions.OutboxStreamAck,
          timestamp: Date.now(),
          payload: { ok: true, okIndices: p.events.map((_e, i) => i) },
        };
        this.send(ack).catch(() => {});
        return;
      }

      case Actions.QueryResponse: {
        if (!msg.requestId) return;
        const resolver = this.pendingQueries.get(msg.requestId);
        if (!resolver) return;
        this.pendingQueries.delete(msg.requestId);

        const pl: any = msg.payload;
        if (pl?.ok === false) throw new Error(String(pl?.err ?? 'query failed'));
        resolver(pl?.data ?? (pl as any)?.payload);
        return;
      }

      default:
        return;
    }
  }
  /* eslint-enable no-empty */

  private async send(frame: Message | string) {
    const s = this.socket;
    if (!s || s.readyState !== s.OPEN) throw new Error('[client-ws] socket is not open');
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
    s.send(data);
  }

  // ---------------------------------------------------------------------------
  // Query API
  // ---------------------------------------------------------------------------

  async query<TRes = any>(requestId: string, payload: QueryRequestPayload, timeoutMs = 5_000): Promise<TRes> {
    const s = this.socket;
    if (!s || s.readyState !== s.OPEN) throw new Error('[client-ws] socket is not open');

    const env: Message<QueryRequestPayload> = {
      action: Actions.QueryRequest,
      requestId,
      timestamp: Date.now(),
      payload,
    };

    let resolveFn!: (v: any) => void;
    const p = new Promise<TRes>((resolve) => (resolveFn = resolve));
    this.pendingQueries.set(requestId, resolveFn);

    this.send(env).catch((e) => {
      this.pendingQueries.delete(requestId);
      throw e;
    });

    const deadline = Date.now() + timeoutMs;
    const backoff = { wait: 16 };

    while (Date.now() < deadline) {
      if (!this.pendingQueries.has(requestId)) return await p;
      await delay(nextBackoff(backoff, { factor: 1.6, max: 300, jitter: 0.2 }));
    }

    this.pendingQueries.delete(requestId);
    throw new Error('[client-ws] query timeout');
  }
}

// -----------------------------------------------------------------------------
// Utilities and types
// -----------------------------------------------------------------------------

type WebSocketCtor = new (url: string, protocols?: string | string[] | undefined, opts?: any) => WebSocketLike;
type WebSocketLike = {
  readonly OPEN: number;
  readyState: number;
  send(data: any): void;
  close(): void;
  onopen: ((ev?: any) => any) | null;
  onmessage: ((ev: { data: any }) => any) | null;
  onclose: ((ev?: any) => any) | null;
  onerror: ((ev?: any) => any) | null;
};

function getNodeWsCtor(): WebSocketCtor {
  try {
    const WS = require('ws');
    return WS;
  } catch {
    throw new Error('[client-ws] "ws" package is required in Node or provide WebSocketCtor');
  }
}
