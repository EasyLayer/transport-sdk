/* eslint-disable no-restricted-syntax */
import WebSocket from 'ws';
/* eslint-enable no-restricted-syntax */
import { Actions, createDomainEventFromWire, utf8Len, TRANSPORT_OVERHEAD_WIRE } from '../core';
import type { Message, OutboxStreamBatchPayload, OutboxStreamAckPayload, QueryResponsePayload } from '../core';

export type WsClientOptions = {
  url: string; // e.g. wss://server:8443/ws
  token?: string; // sent in Sec-WebSocket-Protocol (first protocol)
  clientId?: string; // sent in Sec-WebSocket-Protocol (second protocol)
  pongPassword?: string; // included in Pong payload when replying to app-level Ping
  maxWireBytes?: number; // default 1 MiB
  processTimeoutMs?: number; // default 3000
  /**
   * Optional factory for creating WebSocket instances in managed mode.
   * If provided, connect() and internal reconnects will use this factory.
   */
  socketFactory?: () => WebSocket;
};

/**
 * WsClient
 * -----------------------------------------------------------------------------
 * - Managed mode (connect): creates and owns a socket; auto-reconnects forever with backoff.
 * - Attached mode (attach): uses an external socket; NO internal reconnects.
 * - App-level Ping/Pong: replies with Pong (optionally with password) → server turns online.
 * - Outbox batches: per-type sequential, cross-type parallel; one ACK on success.
 * - Query: single-flight (no parallel queries); QueryRequest → QueryResponse.
 */
export class WsClient {
  private readonly url: string;
  private token?: string;
  private clientId?: string;
  private readonly pongPassword?: string;
  private readonly maxBytes: number;
  private readonly processTimeoutMs: number;
  private readonly socketFactory?: () => WebSocket;

  private ws: WebSocket | null = null;
  private ownsSocket = false; // true when we created the socket (managed mode)
  private reconnecting = false; // internal guard against concurrent reconnect loops
  private connAttempts = 0; // increases while reconnecting in managed mode

  // subscriptions: one handler per event type
  private subs = new Map<string, (evt: any) => unknown | Promise<unknown>>();

  // single-flight query waiting
  private queryInFlight: { resolve: (v: any) => void; reject: (e: any) => void } | null = null;

  constructor(opts: WsClientOptions) {
    if (!opts?.url) throw new Error('[ws-client] url is required');
    this.url = opts.url;
    this.token = opts.token;
    this.clientId = opts.clientId;
    this.pongPassword = opts.pongPassword;
    this.maxBytes = Math.max(1024, opts.maxWireBytes ?? 1024 * 1024);
    this.processTimeoutMs = Math.max(1, opts.processTimeoutMs ?? 3000);
    this.socketFactory = opts.socketFactory;
  }

  // ---- lifecycle ------------------------------------------------------------
  /**
   * Managed mode:
   *  - Tries to open a socket.
   *  - If the first attempt fails (e.g., server not up), it starts an infinite background
   *    reconnect loop and RESOLVES immediately (soft start).
   *  - If the first attempt succeeds, resolves after 'open'.
   */
  async connect(): Promise<void> {
    try {
      await this.openOnce();
    } catch {
      // Soft start: start background infinite reconnects and resolve immediately.
      this.startReconnectLoop();
    }
  }

  /**
   * Attach an existing WebSocket. In this mode the client does NOT perform reconnects.
   * Responsibility for reconnecting stays with the creator of the socket.
   * Optional creds are stored only for potential future switch to managed mode.
   */
  attach(sock: WebSocket, creds?: { token?: string; clientId?: string }) {
    if (creds?.token) this.token = creds.token;
    if (creds?.clientId) this.clientId = creds.clientId;

    this.ws = sock;
    this.ownsSocket = false; // external socket ownership
    this.bindSocket(sock);
  }

  /* eslint-disable no-empty */
  async close(): Promise<void> {
    this.reconnecting = false;
    try {
      this.ws?.close(1000, 'client close');
    } catch {}
    this.ws = null;
  }
  /* eslint-enable no-empty */

  // ---- subscriptions --------------------------------------------------------
  subscribe<T = any>(eventType: string, handler: (evt: T) => unknown | Promise<unknown>) {
    if (this.subs.has(eventType)) throw new Error(`[ws-client] duplicate subscription for type "${eventType}"`);
    this.subs.set(eventType, handler as any);
    return () => {
      const cur = this.subs.get(eventType);
      if (cur === handler) this.subs.delete(eventType);
    };
  }
  getSubscriptionCount(eventType: string): number {
    return this.subs.has(eventType) ? 1 : 0;
  }

  // ---- query ---------------------------------------------------------------
  /**
   * Single-flight query with one deadline for the whole operation.
   * `timeoutMs` covers both sending and receiving a response.
   * Default: 5000 ms.
   */
  async query<TReq = any, TRes = any>(name: string, dto?: TReq, timeoutMs = 5000): Promise<TRes> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('[ws-client] not connected');
    }
    if (this.queryInFlight) {
      throw new Error('[ws-client] query in flight');
    }

    const payload: Message = {
      action: Actions.QueryRequest,
      timestamp: Date.now(),
      payload: { name, dto },
    } as any;

    const s = JSON.stringify(payload);
    if (utf8Len(s) + TRANSPORT_OVERHEAD_WIRE > this.maxBytes) {
      throw new Error('[ws-client] query payload too large');
    }

    return this.withDeadline<TRes>(async (deadlineAt) => {
      let resolveFn!: (v: TRes) => void;
      let rejectFn!: (e: any) => void;
      const waiter = new Promise<TRes>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });

      if (this.queryInFlight) throw new Error('[ws-client] query in flight');
      this.queryInFlight = { resolve: resolveFn, reject: rejectFn };

      try {
        await this.sendTextBeforeDeadline(s, deadlineAt);
      } catch (e) {
        this.queryInFlight = null;
        throw e;
      }

      return waiter;
    }, timeoutMs);
  }

  /* eslint-disable no-empty */
  // ---- inbound message routing --------------------------------------------
  private onMessage = async (text: string) => {
    let msg: Message | null = null;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof (msg as any).action !== 'string') return;

    switch (msg.action) {
      case Actions.Ping: {
        const pong: Message = {
          action: Actions.Pong,
          timestamp: Date.now(),
          payload: this.pongPassword ? { password: this.pongPassword } : undefined,
        } as any;
        try {
          this.ws?.send(JSON.stringify(pong));
        } catch {}
        break;
      }
      case Actions.OutboxStreamBatch: {
        const p = msg.payload as OutboxStreamBatchPayload;
        try {
          await this.processBatchWithTimeout(p);
          const ack: Message<OutboxStreamAckPayload> = {
            action: Actions.OutboxStreamAck,
            timestamp: Date.now(),
            payload: { ok: true, okIndices: p.events.map((_e, i) => i) },
          } as any;
          this.ws?.send(JSON.stringify(ack));
        } catch {
          // No ACK on failure — server will retry
        }
        break;
      }
      case Actions.QueryResponse: {
        const qr = msg.payload as QueryResponsePayload as any;
        const inflight = this.queryInFlight;
        this.queryInFlight = null;
        if (!inflight) return;
        if (!qr || typeof qr.ok !== 'boolean') inflight.reject(new Error('invalid query response'));
        else if (qr.ok === false) inflight.reject(new Error(String(qr.err ?? 'query failed')));
        else inflight.resolve(qr.data);
        break;
      }
      default:
        // ignore anything else
        break;
    }
  };
  /* eslint-enable no-empty */

  // ---- batch processing -----------------------------------------------------
  private async processBatchWithTimeout(batch: OutboxStreamBatchPayload): Promise<void> {
    const work = this.dispatchBatch(batch);
    await this.withTimeout(work, this.processTimeoutMs);
  }

  private async dispatchBatch(batch: OutboxStreamBatchPayload) {
    const wires = batch.events ?? [];
    if (!wires.length) return;

    // Build per-type index lists (cheap routing)
    const perTypeIdx = new Map<string, number[]>();
    for (let i = 0; i < wires.length; i++) {
      const w = wires[i]!;
      if (!this.subs.has(w.eventType)) continue;
      let arr = perTypeIdx.get(w.eventType);
      if (!arr) perTypeIdx.set(w.eventType, (arr = []));
      arr.push(i);
    }

    if (perTypeIdx.size === 0) return; // nothing to wait for

    const tasks: Promise<void>[] = [];
    for (const [type, idxs] of perTypeIdx) {
      const handler = this.subs.get(type)!;
      tasks.push(
        (async () => {
          for (let k = 0; k < idxs.length; k++) {
            const wire = wires[idxs[k]!]!;
            const evt = createDomainEventFromWire(wire);
            await Promise.resolve().then(() => handler(evt));
          }
        })()
      );
    }

    await Promise.all(tasks);
  }

  // ---- helpers --------------------------------------------------------------
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('batch processing timeout')), ms);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  /** Run `fn` with a hard deadline (Date.now() + timeoutMs). */
  private async withDeadline<T>(fn: (deadlineAt: number) => Promise<T>, timeoutMs: number): Promise<T> {
    const deadlineAt = Date.now() + Math.max(1, timeoutMs);
    let timer: any;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          // clear single-flight guard if still pending
          const inflight = this.queryInFlight;
          this.queryInFlight = null;
          inflight?.reject?.(new Error('query response timeout'));
          reject(new Error('query timeout'));
        },
        Math.max(1, timeoutMs)
      );
    });
    try {
      const result = await Promise.race([fn(deadlineAt), timeoutPromise]);
      clearTimeout(timer);
      return result as T;
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  /** Send a text frame before a given deadline; throws on timeout or send error. */
  private sendTextBeforeDeadline(text: string, deadlineAt: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('[ws-client] not connected'));
      }
      const now = Date.now();
      const remaining = Math.max(1, deadlineAt - now);
      let timer: any;
      try {
        timer = setTimeout(() => reject(new Error('send timeout')), remaining);
        this.ws.send(text, (err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        });
      } catch (e: any) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // ---- managed socket (Node-only) ------------------------------------------
  /**
   * Opens a socket once (no retry inside). Throws if fails.
   */
  private async openOnce(): Promise<void> {
    const protocols: string[] = [];
    if (this.token) protocols.push(this.token);
    if (this.clientId) protocols.push(this.clientId);

    const ws = this.socketFactory
      ? this.socketFactory()
      : new WebSocket(this.url, protocols.length ? protocols : undefined);

    this.ws = ws;
    this.ownsSocket = true; // managed mode
    this.bindSocket(ws);

    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
  }

  /**
   * Starts infinite reconnect loop with backoff (managed mode only).
   * Backoff: 200ms → 400 → 800 → ... up to 3000ms, then steady 3000ms.
   */
  private startReconnectLoop() {
    if (this.reconnecting) return;
    this.reconnecting = true;

    const loop = async () => {
      while (this.reconnecting) {
        try {
          await this.openOnce();
          this.connAttempts = 0;
          this.reconnecting = false; // connected
          return;
        } catch {
          this.connAttempts++;
          const delayMs = this.computeBackoffMs(this.connAttempts);
          await delay(delayMs);
        }
      }
    };

    // fire-and-forget
    loop().catch(() => {
      /* noop */
    });
  }

  private computeBackoffMs(attempt: number): number {
    const base = 200; // 0.2s
    const cap = 3000; // 3s max
    // exponential growth: 200 * 2^(attempt-1)
    const ms = base * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(cap, ms);
  }

  private bindSocket(ws: WebSocket) {
    ws.on('message', (d) => this.onMessage(String(d)));

    ws.on('close', () => {
      // Only auto-reconnect if we own the socket (managed mode)
      if (this.ownsSocket) {
        this.startReconnectLoop();
      }
    });

    ws.on('error', () => {
      // Error may arrive before 'close'; trigger reconnect if managed
      if (this.ownsSocket) {
        this.startReconnectLoop();
      }
    });
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
