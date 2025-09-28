import type { Message, OutboxStreamAckPayload, OutboxStreamBatchPayload, QueryRequestPayload } from '../core';
import { Actions, createDomainEventFromWire } from '../core';
import { uuid, normalize, nextBackoff, delay } from '../core';

/**
 * ElectronRendererClient
 * -----------------------------------------------------------------------------
 * Role:
 * - Runs in the Electron renderer process and communicates with the main process
 *   over IPC on the 'transport:message' channel.
 * - Mirrors the server-side ElectronIpcMainService protocol:
 *   * Ping/Pong with optional password.
 *   * Outbox batch -> fan-out -> send Ack.
 *   * Query request/response.
 *
 * Ownership:
 * - Does not manage BrowserWindow; only wires ipcRenderer listeners.
 * - Cleans up listeners on `close()`.
 *
 * Extensibility:
 * - `tapRaw` to observe every incoming envelope before built-in routing.
 * - `onAction(action, handler)` to react to custom actions.
 * - `sendRaw(frame)` to send custom envelopes back to main.
 */
export class ElectronIpcRendererClient {
  private readonly ipc: IpcRendererLike;
  private readonly pongPassword?: string;

  private subs = new Map<string, Set<(evt: any) => unknown | Promise<unknown>>>();
  private pendingQueries = new Map<string, (payload: any) => void>();

  private rawHandlers = new Set<(m: Message) => void>();
  private actionHandlers = new Map<string, Set<(m: Message) => void>>();

  private readonly onIpc = (_: any, raw: unknown) => this.handleIncoming(raw);

  constructor(opts?: { ipcRenderer?: IpcRendererLike; pongPassword?: string }) {
    // Resolve ipcRenderer: allow injection (tests) or use global require
    this.ipc = opts?.ipcRenderer ?? getIpcRenderer();
    this.pongPassword = opts?.pongPassword;

    this.ipc.on('transport:message', this.onIpc);
  }

  // -----------------------------------------------------------------------------
  // Usage examples:
  // -----------------------------------------------------------------------------
  // const c = new ElectronRendererClient({ pongPassword: 'pw' });
  // c.subscribe('UserCreated', (e) => {});
  // const res = await c.query('GetUser', { id: 1 });
  // c.tapRaw((m) => console.log('[renderer raw]', m.action));
  // c.onAction('custom.message', (m) => console.log(m.payload));
  // await c.sendRaw({ action: 'custom.request', payload: { x: 1 } });

  // ---- subscriptions ----
  subscribe<T = any>(constructorName: string, handler: (evt: T) => unknown | Promise<unknown>): () => void {
    const set = this.subs.get(constructorName) ?? new Set();
    set.add(handler as any);
    this.subs.set(constructorName, set);
    return () => set.delete(handler as any);
  }
  getSubscriptionCount(constructorName: string): number {
    return this.subs.get(constructorName)?.size ?? 0;
  }

  // ---- extensibility ----
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
  async sendRaw(frame: Message | string): Promise<void> {
    const payload = typeof frame === 'string' ? frame : frame;
    this.ipc.send('transport:message', payload);
  }

  // ---- query ----
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

    this.ipc.send('transport:message', env);

    // Exponential backoff loop (simple, jittered)
    const deadline = Date.now() + timeoutMs;
    const backoff = { wait: 16 };

    while (Date.now() < deadline) {
      if (!this.pendingQueries.has(requestId)) return await p;
      await delay(nextBackoff(backoff, { factor: 1.6, max: 300, jitter: 0.2 }));
    }

    this.pendingQueries.delete(requestId);
    throw new Error('[client-electron-renderer] query timeout');
  }

  async close(): Promise<void> {
    this.ipc.off('transport:message', this.onIpc);
    this.pendingQueries.clear();
    this.subs.clear();
    this.rawHandlers.clear();
    this.actionHandlers.clear();
  }

  /* eslint-disable no-empty */
  // ---- inbound routing ----
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
        this.ipc.send('transport:message', pong);
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
        this.ipc.send('transport:message', ack);
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
}

// -----------------------------------------------------------------------------
// IPC types + helpers
// -----------------------------------------------------------------------------

type IpcRendererLike = {
  on(channel: string, listener: (...args: any[]) => void): void;
  off(channel: string, listener: (...args: any[]) => void): void;
  send(channel: string, ...args: any[]): void;
};

function getIpcRenderer(): IpcRendererLike {
  // Try global require (NodeIntegration) or window.electron.ipcRenderer pattern
  try {
    const { ipcRenderer } = require('electron');
    if (!ipcRenderer) throw new Error();
    return ipcRenderer as IpcRendererLike;
  } catch {
    const maybe = (globalThis as any)?.electron?.ipcRenderer ?? (globalThis as any)?.ipcRenderer;
    if (!maybe) throw new Error('[client-electron-renderer] ipcRenderer not available; pass it via opts.ipcRenderer');
    return maybe as IpcRendererLike;
  }
}
