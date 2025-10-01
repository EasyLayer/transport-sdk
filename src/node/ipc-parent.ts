import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type {
  Message,
  OutboxStreamBatchPayload,
  OutboxStreamAckPayload,
  QueryRequestPayload,
  QueryResponsePayload,
} from '../core';
import { Actions, createDomainEventFromWire } from '../core';

export type IpcParentClientOptions = {
  /** A connected ChildProcess created with stdio including 'ipc'. */
  child: ChildProcess;
  /** If set, included as { password } in Pong on app-level Ping. */
  pongPassword?: string;
  /** Processing timeout for a batch before replying with ACK. Default: 3000 ms. */
  processTimeoutMs?: number;
};

function assertIpcParentRuntime() {
  const p: any = process;
  if (p && p.channel) {
    throw new Error('[ipc-parent] running inside a child; parent runtime expected');
  }
}

/**
 * IpcParentClient
 * -----------------------------------------------------------------------------
 * Runs in the parent process, bound to a single ChildProcess.
 * - Replies to Ping with Pong (optionally with password).
 * - Accepts Outbox batches and sends ACK after processing.
 * - Supports parallel queries using correlationId mapping.
 * - IMPORTANT: For IPC we include BOTH correlationId and requestId in outgoing messages.
 */
export class IpcParentClient {
  private readonly child: ChildProcess;
  private readonly pongPassword?: string;
  private readonly processTimeoutMs: number;

  // One handler per event type (sequential per type, parallel across types)
  private subs = new Map<string, (evt: any) => unknown | Promise<unknown>>();

  // correlationId → resolver
  private pendingQueries = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: any }>();

  // exact handler reference to remove on close
  private childMessageHandler!: (raw: unknown) => void;

  constructor(opts: IpcParentClientOptions) {
    assertIpcParentRuntime();
    if (
      !opts?.child ||
      typeof opts?.child?.send !== 'function' ||
      !(opts?.child as any)?.on ||
      !(opts?.child as any)?.channel
    ) {
      throw new Error('[ipc-parent] invalid child: must be forked with IPC channel');
    }
    this.child = opts.child;
    this.pongPassword = opts.pongPassword;
    this.processTimeoutMs = Math.max(1, opts.processTimeoutMs ?? 3000);

    this.childMessageHandler = this.onChildMessage.bind(this);
    this.child.on('message', this.childMessageHandler);
    this.child.once('exit', () => {
      this.child.off('message', this.childMessageHandler);
      for (const [, p] of this.pendingQueries) clearTimeout(p.timer);
      this.pendingQueries.clear();
      this.subs.clear();
    });
  }

  // ---- subscriptions --------------------------------------------------------
  subscribe<T = any>(eventType: string, handler: (evt: T) => unknown | Promise<unknown>) {
    if (this.subs.has(eventType)) throw new Error(`[ipc-parent] duplicate subscription for type "${eventType}"`);
    this.subs.set(eventType, handler as any);
    return () => {
      const cur = this.subs.get(eventType);
      if (cur === handler) this.subs.delete(eventType);
    };
  }
  getSubscriptionCount(eventType: string): number {
    return this.subs.has(eventType) ? 1 : 0;
  }

  // ---- query (client -> server) --------------------------------------------
  async query<TReq = any, TRes = any>(name: string, dto?: TReq, timeoutMs = 5000): Promise<TRes> {
    const correlationId = randomUUID();
    const requestId = randomUUID();

    const req: Message<QueryRequestPayload> = {
      action: Actions.QueryRequest,
      correlationId,
      requestId,
      timestamp: Date.now(),
      payload: { name, dto },
    } as any;

    const p = new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pendingQueries.delete(correlationId);
          reject(new Error('[ipc-parent] query timeout'));
        },
        Math.max(1, timeoutMs)
      );
      this.pendingQueries.set(correlationId, { resolve, reject, timer });
    });

    try {
      this.child.send?.(req as any);
    } catch (e: any) {
      const pending = this.pendingQueries.get(correlationId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingQueries.delete(correlationId);
      }
      throw e;
    }

    return p;
  }

  /* eslint-disable no-empty */
  async close(): Promise<void> {
    try {
      this.child.off('message', this.childMessageHandler);
    } catch {}
    for (const [, p] of this.pendingQueries) clearTimeout(p.timer);
    this.pendingQueries.clear();
    this.subs.clear();
  }
  /* eslint-enable no-empty */

  /* eslint-disable no-empty */
  // ---- inbound routing (server -> client) ----------------------------------
  private async onChildMessage(raw: unknown) {
    const msg = this.normalize(raw);
    if (!msg?.action) return;

    switch (msg.action) {
      case Actions.Ping: {
        const pong: Message = {
          action: Actions.Pong,
          correlationId: msg.correlationId || randomUUID(),
          requestId: randomUUID(),
          timestamp: Date.now(),
          payload: this.pongPassword ? { password: this.pongPassword } : undefined,
        } as any;
        try {
          this.child.send?.(pong as any);
        } catch {}
        return;
      }

      case Actions.OutboxStreamBatch: {
        const p = msg.payload as OutboxStreamBatchPayload;
        try {
          await this.processBatchWithTimeout(p);
          const ack: Message<OutboxStreamAckPayload> = {
            action: Actions.OutboxStreamAck,
            correlationId: msg.correlationId || randomUUID(),
            requestId: randomUUID(),
            timestamp: Date.now(),
            payload: { ok: true, okIndices: (p.events ?? []).map((_e, i) => i) },
          } as any;
          this.child.send?.(ack as any);
        } catch {
          // on failure do not ACK: server will retry
        }
        return;
      }

      case Actions.QueryResponse: {
        const id = msg.correlationId;
        if (!id) return;
        const pending = this.pendingQueries.get(id);
        if (!pending) return;
        this.pendingQueries.delete(id);
        clearTimeout(pending.timer);

        const payload = msg.payload as QueryResponsePayload as any;
        if (!payload || typeof payload.ok !== 'boolean') pending.reject(new Error('invalid query response'));
        else if (payload.ok === false) pending.reject(new Error(String(payload.err ?? 'query failed')));
        else pending.resolve(payload.data);
        return;
      }

      default:
        return;
    }
  }
  /* eslint-enable no-empty */

  // ---- batch processing -----------------------------------------------------
  private async processBatchWithTimeout(batch: OutboxStreamBatchPayload): Promise<void> {
    const work = this.dispatchBatch(batch);
    await this.withTimeout(work, this.processTimeoutMs);
  }

  private async dispatchBatch(batch: OutboxStreamBatchPayload) {
    const wires = batch.events ?? [];
    if (!wires.length) return;

    const perTypeIdx = new Map<string, number[]>();
    for (let i = 0; i < wires.length; i++) {
      const w = wires[i]!;
      if (!this.subs.has(w.eventType)) continue;
      let arr = perTypeIdx.get(w.eventType);
      if (!arr) perTypeIdx.set(w.eventType, (arr = []));
      arr.push(i);
    }

    if (perTypeIdx.size === 0) return;

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

  // ---- utils ----------------------------------------------------------------
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

  private normalize(raw: unknown): Message | null {
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
}
