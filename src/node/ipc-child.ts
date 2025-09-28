import type { Message, OutboxStreamAckPayload, OutboxStreamBatchPayload, QueryRequestPayload } from '../core';
import { Actions, createDomainEventFromWire } from '../core';
import { normalize, delay, uuid, nextBackoff } from '../core';
/**
 * IpcChildClient
 * -----------------------------------------------------------------------------
 * Role:
 * - Runs inside a child process (spawned with IPC channel).
 * - Communicates with the parent via `process.send` / `process.on('message', ...)`.
 * - Mirrors the server's IpcChildTransportService protocol:
 *   * Ping/Pong with optional password.
 *   * Outbox batch -> fan-out -> send Ack.
 *   * Query request/response.
 *
 * Ownership:
 * - Does not manage process lifecycle; only wires message handlers.
 * - Cleans up listeners on `close()`.
 */
export class IpcChildClient {
  private subs = new Map<string, Set<(evt: any) => unknown | Promise<unknown>>>();
  private pendingQueries = new Map<string, (payload: any) => void>();

  private readonly pongPassword?: string;
  private onMessageBound = (raw: unknown) => this.onRaw(raw);

  constructor(opts: { pongPassword?: string } = {}) {
    this.pongPassword = opts.pongPassword;
    (process as any).on?.('message', this.onMessageBound);
  }

  // ---------------------------------------------------------------------------
  // Usage examples:
  // ---------------------------------------------------------------------------
  // // In child.js:
  // const c = new IpcChildClient({ pongPassword: 'pw' });
  // c.subscribe('UserCreated', (e) => { ... });
  // const res = await c.query('GetUser', { id: 1 });
  //
  // // Parent spawns child with stdio: ['inherit','inherit','inherit','ipc']

  subscribe<T = any>(constructorName: string, handler: (evt: T) => unknown | Promise<unknown>): () => void {
    const set = this.subs.get(constructorName) ?? new Set();
    set.add(handler as any);
    this.subs.set(constructorName, set);
    return () => set.delete(handler as any);
  }
  getSubscriptionCount(constructorName: string): number {
    return this.subs.get(constructorName)?.size ?? 0;
  }

  async query<TReq, TRes>(name: string, dto?: TReq, timeoutMs = 5_000): Promise<TRes> {
    const requestId = uuid();
    const env: Message<QueryRequestPayload> = {
      action: Actions.QueryRequest,
      requestId,
      timestamp: Date.now(),
      payload: { name, dto },
    };

    let resolveFn!: (v: any) => void;
    const p = new Promise<TRes>((resolve) => (resolveFn = resolve));
    this.pendingQueries.set(requestId, resolveFn);

    (process as any).send?.(env);

    const deadline = Date.now() + timeoutMs;
    const backoff = { wait: 16 };

    while (Date.now() < deadline) {
      if (!this.pendingQueries.has(requestId)) return await p;
      await delay(nextBackoff(backoff, { factor: 1.6, max: 300, jitter: 0.2 }));
    }

    this.pendingQueries.delete(requestId);
    throw new Error('[client-ipc-child] query timeout');
  }

  async close(): Promise<void> {
    (process as any).off?.('message', this.onMessageBound);
    this.pendingQueries.clear();
    this.subs.clear();
  }

  // ---- inbound routing ----
  private async onRaw(raw: unknown) {
    const msg = normalize(raw);
    if (!msg?.action) return;

    switch (msg.action) {
      case Actions.Ping: {
        const pong: Message<{ password?: string }> = {
          action: Actions.Pong,
          payload: this.pongPassword ? { password: this.pongPassword } : undefined,
          timestamp: Date.now(),
        };
        (process as any).send?.(pong);
        return;
      }

      case Actions.OutboxStreamBatch: {
        const p = msg.payload as OutboxStreamBatchPayload;
        if (!p || !Array.isArray(p.events)) return;

        for (const w of p.events) {
          const set = this.subs.get(w.eventType || 'UnknownEvent');
          if (!set?.size) continue;
          const evt = createDomainEventFromWire(w);
          for (const h of set) await h(evt);
        }

        const ack: Message<OutboxStreamAckPayload> = {
          action: Actions.OutboxStreamAck,
          timestamp: Date.now(),
          payload: { ok: true, okIndices: p.events.map((_e, i) => i) },
        };
        (process as any).send?.(ack);
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
}
