import type { ChildProcess } from 'node:child_process';
import type { Message, OutboxStreamAckPayload, OutboxStreamBatchPayload, QueryRequestPayload } from '../core';
import { Actions, createDomainEventFromWire } from '../core';
import { normalize, delay, uuid, nextBackoff } from '../core';

/**
 * IpcParentClient
 * -----------------------------------------------------------------------------
 * Role:
 * - Runs in the parent process and communicates with a given ChildProcess.
 * - Mirrors the server's IpcParentTransportService protocol:
 *   * Ping/Pong with optional password.
 *   * Outbox batch -> fan-out -> send Ack.
 *   * Query request/response.
 *
 * Ownership:
 * - Does not spawn/respawn the child; only binds to it.
 */
export class IpcParentClient {
  private readonly child: ChildProcess;
  private subs = new Map<string, Set<(evt: any) => unknown | Promise<unknown>>>();
  private pendingQueries = new Map<string, (payload: any) => void>();

  private readonly pongPassword?: string;
  private onMessageBound = (raw: unknown) => this.onRaw(raw);

  constructor(child: ChildProcess, opts: { pongPassword?: string } = {}) {
    this.child = child;
    this.pongPassword = opts.pongPassword;
    this.child.on('message', this.onMessageBound);
    this.child.once('exit', () => {
      this.child.off('message', this.onMessageBound);
      this.pendingQueries.clear();
      this.subs.clear();
    });
  }

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
          reject(new Error('ipc-parent: query timeout'));
        },
        Math.max(1, timeoutMs)
      );

      this.pendingQueries.set(requestId, (payload: any) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
    this.child.send?.(env as any);
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
        this.child.off('message', handler);
      };

      this.child.on('message', handler);
      this.child.send?.(env as any);

      timer = setTimeout(
        () => {
          cleanup();
          reject(new Error('ipc-parent: ack timeout'));
        },
        Math.max(1, timeoutMs)
      );
    });
  }

  close() {
    this.child.off('message', this.onMessageBound);
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
        this.child.send?.(pong as any);
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
        this.child.send?.(ack as any);
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
