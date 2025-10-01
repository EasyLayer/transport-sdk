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

    let timer: any;
    const p = new Promise<TRes>((resolve, reject) => {
      timer = setTimeout(
        () => {
          this.pendingQueries.delete(requestId);
          reject(new Error('ipc-child: query timeout'));
        },
        Math.max(1, timeoutMs)
      );

      this.pendingQueries.set(requestId, (payload: any) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
    (process as any).send?.(env);
    return p;
  }

  async sendBatch(events: OutboxStreamBatchPayload, timeoutMs = 3_000): Promise<OutboxStreamAckPayload> {
    const requestId = uuid();
    const env: Message<OutboxStreamBatchPayload> = {
      action: Actions.OutboxStreamBatch,
      requestId,
      timestamp: Date.now(),
      payload: events,
    };

    let timer: any;
    return await new Promise<OutboxStreamAckPayload>((resolve, reject) => {
      const handler = (raw: unknown) => {
        const msg = normalize(raw);
        if (!msg || msg.action !== Actions.OutboxStreamAck || msg.requestId !== requestId) return;
        cleanup();
        resolve(msg.payload as any as OutboxStreamAckPayload);
      };

      const cleanup = () => {
        clearTimeout(timer);
        (process as any).off?.('message', handler);
      };

      (process as any).on?.('message', handler);
      (process as any).send?.(env);

      timer = setTimeout(
        () => {
          cleanup();
          reject(new Error('ipc-child: ack timeout'));
        },
        Math.max(1, timeoutMs)
      );
    });
  }

  close() {
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
        const events = (msg.payload as any)?.events ?? [];
        for (const e of events) {
          const evt = createDomainEventFromWire(e);
          const set = this.subs.get(evt.constructor.name);
          if (!set?.size) continue;
          for (const fn of set) {
            try {
              await fn(evt);
            } catch {
              // swallow user handler errors
            }
          }
        }
        const ack: Message<OutboxStreamAckPayload> = {
          action: Actions.OutboxStreamAck,
          requestId: msg.requestId,
          timestamp: Date.now(),
          payload: { ok: true },
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
