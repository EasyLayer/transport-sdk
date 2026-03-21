import type {
  Message,
  OutboxStreamAckPayload,
  OutboxStreamBatchPayload,
  QueryRequestPayload,
  QueryResponsePayload,
} from '../core';
import { Actions, createDomainEventFromWire, uuid, nextBackoff, delay } from '../core';

export type SharedWorkerClientOptions = {
  /** URL of the SharedWorker script (compiled bundle). */
  url: string;
  /** Optional password — must match SharedWorkerServer pongPassword. */
  pongPassword?: string;
  /** Query timeout in ms. Default: 10_000. */
  queryTimeoutMs?: number;
};

/**
 * SharedWorkerClient
 * -----------------------------------------------------------------------------
 * Runs in a browser window/tab. Connects to a SharedWorker and provides:
 *   - subscribe(eventName, handler)  — receive domain events pushed by the worker
 *   - query(name, dto)               — request/response query to the worker's QueryBus
 *   - tapRaw / onAction              — low-level message hooks
 *
 * The SharedWorker must run SharedWorkerServer and wire:
 *   self.onconnect = (e) => server.addPort(e.ports[0]);
 *
 * Usage in window:
 *
 *   const client = new SharedWorkerClient({ url: '/worker.js' });
 *   const balance = await client.query('GetBalanceQuery', { addresses: ['1A1z...'] });
 *   client.subscribe('BasicWalletDelta', (evt) => console.log(evt));
 */
export class SharedWorkerClient {
  private readonly worker: SharedWorker;
  private readonly port: MessagePort;
  private readonly opts: SharedWorkerClientOptions;

  private online = false;
  private lastPongAt = 0;

  private subs = new Map<string, Set<(evt: any) => unknown | Promise<unknown>>>();
  private pendingQueries = new Map<string, (payload: any) => void>();
  private rawHandlers = new Set<(m: Message) => void>();
  private actionHandlers = new Map<string, Set<(m: Message) => void>>();

  constructor(opts: SharedWorkerClientOptions) {
    if (!opts?.url) throw new Error('[shared-worker-client] url is required');
    this.opts = opts;

    this.worker = new SharedWorker(opts.url);
    this.port = this.worker.port;

    this.port.onmessage = (ev) => this.handleIncoming(ev.data);
    this.port.onmessageerror = () => {
      /* port error */
    };
    this.port.start();
  }

  // ---------------------------------------------------------------------------
  // Subscriptions — receive events pushed from the worker
  // ---------------------------------------------------------------------------

  subscribe<T = any>(eventName: string, handler: (evt: T) => unknown | Promise<unknown>): () => void {
    const set = this.subs.get(eventName) ?? new Set();
    set.add(handler as any);
    this.subs.set(eventName, set);
    return () => set.delete(handler as any);
  }

  getSubscriptionCount(eventName: string): number {
    return this.subs.get(eventName)?.size ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Query — send query.request, await query.response
  // ---------------------------------------------------------------------------

  async query<TReq = unknown, TRes = unknown>(name: string, dto?: TReq, timeoutMs?: number): Promise<TRes> {
    const requestId = uuid();
    const timeout = timeoutMs ?? this.opts.queryTimeoutMs ?? 10_000;

    const req: Message<QueryRequestPayload> = {
      action: Actions.QueryRequest,
      requestId,
      timestamp: Date.now(),
      payload: { name, dto },
    };

    let resolveFn!: (v: any) => void;
    const p = new Promise<TRes>((resolve) => (resolveFn = resolve));
    this.pendingQueries.set(requestId, resolveFn);

    this.send(req);

    // Poll with exponential backoff until response arrives or timeout
    const deadline = Date.now() + timeout;
    const backoff = { wait: 16 };

    while (Date.now() < deadline) {
      if (!this.pendingQueries.has(requestId)) return await p;
      await delay(nextBackoff(backoff, { factor: 1.6, max: 300, jitter: 0.2 }));
    }

    this.pendingQueries.delete(requestId);
    throw new Error(`[shared-worker-client] query "${name}" timed out after ${timeout}ms`);
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

  /** Whether the worker has replied to a ping recently. */
  isOnline(): boolean {
    return this.online && Date.now() - this.lastPongAt < 15_000;
  }

  /** Send a ping to check liveness. */
  ping(): void {
    this.send({ action: Actions.Ping, requestId: uuid(), timestamp: Date.now() });
  }

  async close(): Promise<void> {
    this.port.close();
    this.subs.clear();
    this.pendingQueries.clear();
    this.rawHandlers.clear();
    this.actionHandlers.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /* eslint-disable no-empty */
  private async handleIncoming(raw: unknown): Promise<void> {
    const msg = normalize(raw);
    if (!msg?.action) return;

    // Raw tap
    for (const h of this.rawHandlers) {
      try {
        h(msg);
      } catch {}
    }

    // Action hooks
    const ah = this.actionHandlers.get(msg.action);
    if (ah?.size) {
      for (const h of ah) {
        try {
          h(msg);
        } catch {}
      }
    }

    switch (msg.action) {
      case Actions.Pong: {
        const pw = (msg.payload as any)?.password;
        const ok = this.opts.pongPassword ? pw === this.opts.pongPassword : true;
        if (ok) {
          this.lastPongAt = Date.now();
          this.online = true;
        }
        return;
      }

      case Actions.OutboxStreamBatch: {
        // Worker pushed an event batch — fan out to subscribers
        const p = msg.payload as OutboxStreamBatchPayload;
        if (!p || !Array.isArray(p.events)) return;

        for (const wire of p.events) {
          const set = this.subs.get(wire.eventType || 'UnknownEvent');
          if (!set?.size) continue;
          const evt = createDomainEventFromWire(wire);
          for (const h of set) await h(evt);
        }

        // Reply with ACK so worker can advance outbox cursor if configured
        const ack: Message<OutboxStreamAckPayload> = {
          action: Actions.OutboxStreamAck,
          requestId: msg.requestId,
          timestamp: Date.now(),
          payload: { ok: true, okIndices: p.events.map((_e, i) => i) },
        };
        this.send(ack);
        return;
      }

      case Actions.QueryResponse: {
        if (!msg.requestId) return;
        const resolver = this.pendingQueries.get(msg.requestId);
        if (!resolver) return;
        this.pendingQueries.delete(msg.requestId);

        const pl = msg.payload as QueryResponsePayload;
        if (pl?.ok === false) throw new Error(String(pl?.err ?? 'query failed'));
        resolver(pl?.data ?? (pl as any)?.payload);
        return;
      }

      default:
        return;
    }
  }
  /* eslint-enable no-empty */

  private send(msg: Message): void {
    this.port.postMessage(JSON.stringify(msg));
  }
}

// -----------------------------------------------------------------------------
// Helper
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
  if (typeof raw === 'object') return raw as Message;
  return null;
}
