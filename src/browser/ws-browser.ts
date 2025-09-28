import type { Message, OutboxStreamAckPayload, OutboxStreamBatchPayload } from '../core';
import { Actions, createDomainEventFromWire } from '../core';

/**
 * WsBrowserClient
 * -----------------------------------------------------------------------------
 * Role:
 * - Runs in a real browser (window.WebSocket).
 * - Accepts 'ping' -> replies 'pong' (with optional { password }).
 * - Accepts 'outbox.stream.batch' -> fan-out to subscribers -> replies 'outbox.stream.ack'.
 * - Does NOT support 'query.request' (browser has no server).
 *
 * Ownership:
 * - Owns a WebSocket to server (ws/wss URL), optional auto-reconnect.
 *
 * Extensibility:
 * - tapRaw(handler): observe all incoming envelopes before routing.
 * - onAction(action, handler): intercept custom actions.
 */
export class WsBrowserClient {
  private socket?: WebSocket;
  private readonly url: string;
  private readonly protocols?: string | string[];
  private readonly pongPassword?: string;

  private reconnect?: { min: number; max: number; factor: number; jitter: number; enabled: boolean };
  private reconnectTimer?: number;
  private closedManually = false;

  private subs = new Map<string, Set<(evt: any) => unknown | Promise<unknown>>>();
  private rawHandlers = new Set<(m: Message) => void>();
  private actionHandlers = new Map<string, Set<(m: Message) => void>>();

  constructor(opts: {
    url: string; // ws:// or wss://
    protocols?: string | string[]; // optional subprotocols
    pongPassword?: string; // will be included in pong.payload.password
    reconnect?: { minMs?: number; maxMs?: number; factor?: number; jitter?: number; enabled?: boolean };
  }) {
    if (!opts?.url) throw new Error('[ws-browser] url is required');
    this.url = opts.url;
    this.protocols = opts.protocols;
    this.pongPassword = opts.pongPassword;

    const r = opts.reconnect ?? {};
    this.reconnect = {
      min: Math.max(100, r.minMs ?? 500),
      max: Math.max(1000, r.maxMs ?? 5000),
      factor: Math.max(1.1, r.factor ?? 1.6),
      jitter: Math.max(0, r.jitter ?? 0.2),
      enabled: !!r.enabled,
    };

    this.open();
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
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
  // Extensibility
  // ---------------------------------------------------------------------------

  tapRaw(handler: (msg: Message) => void): () => void {
    this.rawHandlers.add(handler);
    return () => this.rawHandlers.delete(handler);
  }
  onAction(action: string, handler: (msg: Message) => void): () => void {
    const set = this.actionHandlers.get(action) ?? new Set<(m: Message) => void>();
    set.add(handler);
    this.actionHandlers.set(action, set);
    return () => set.delete(handler);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /* eslint-disable no-empty */
  async close(): Promise<void> {
    this.closedManually = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined as any;
    }
    try {
      this.socket?.close();
    } catch {}
    this.socket = undefined;
    this.subs.clear();
    this.rawHandlers.clear();
    this.actionHandlers.clear();
  }
  /* eslint-enable no-empty */

  private open(): void {
    const ws = new WebSocket(this.url, this.protocols);
    this.socket = ws;
    this.closedManually = false;

    ws.onopen = () => {
      /* server drives ping->pong */
    };
    ws.onmessage = (ev) => this.handleIncoming((ev as MessageEvent).data);
    ws.onclose = () => this.onClosed();
    ws.onerror = () => {
      /* swallow; onclose handles flow */
    };
  }

  private onClosed() {
    if (this.closedManually) return;
    if (!this.reconnect?.enabled) return;

    const next = computeBackoff(this.reconnect!);
    this.reconnectTimer = setTimeout(() => {
      this.reconnect!.min = Math.min(this.reconnect!.max, this.reconnect!.min * this.reconnect!.factor);
      this.open();
    }, next) as unknown as number;
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  /* eslint-disable no-empty */
  private async handleIncoming(raw: unknown) {
    const msg = normalize(raw);
    if (!msg?.action) return;

    // user taps first
    for (const h of this.rawHandlers) {
      try {
        h(msg);
      } catch {}
    }
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
          payload: this.pongPassword ? { password: this.pongPassword } : undefined,
          timestamp: Date.now(),
        };
        this.send(pong);
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
        this.send(ack);
        return;
      }

      // 'query.request' intentionally NOT supported on browser side
      default:
        return;
    }
  }
  /* eslint-enable no-empty */

  private send(frame: Message | string) {
    const s = this.socket;
    if (!s || s.readyState !== WebSocket.OPEN) return;
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
    s.send(data);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function normalize(raw: unknown): Message | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Message;
    } catch {
      return null;
    }
  }
  if (raw instanceof ArrayBuffer) {
    try {
      return JSON.parse(new TextDecoder().decode(raw)) as Message;
    } catch {
      return null;
    }
  }
  if (typeof Blob !== 'undefined' && raw instanceof Blob) {
    /* not handling blobs here */ return null;
  }
  if (typeof raw === 'object') return raw as Message;
  return null;
}

function computeBackoff(r: { min: number; max: number; factor: number; jitter: number }): number {
  const base = r.min;
  const jitter = base * r.jitter * (Math.random() * 2 - 1);
  return Math.max(50, Math.min(r.max, base + jitter));
}
