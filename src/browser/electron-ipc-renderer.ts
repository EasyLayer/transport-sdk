import type { Message, OutboxStreamAckPayload, OutboxStreamBatchPayload } from '../core';
import { Actions, createDomainEventFromWire } from '../core';

/**
 * ElectronRendererTransport (browser-side in renderer)
 * -----------------------------------------------------------------------------
 * Role:
 * - Runs in Electron renderer and talks to main via 'transport:message'.
 * - Accepts 'ping' -> replies 'pong' (with optional { password }).
 * - Accepts 'outbox.stream.batch' -> fan-out -> replies 'outbox.stream.ack'.
 * - Does NOT support 'query.request' (renderer acts as sink for batches).
 *
 * Extensibility:
 * - tapRaw(handler): observe every envelope before routing.
 * - onAction(action, handler): react to custom actions.
 */
export class ElectronRendererTransport {
  private readonly ipc: IpcRendererLike;
  private readonly pongPassword?: string;

  private subs = new Map<string, Set<(evt: any) => unknown | Promise<unknown>>>();
  private rawHandlers = new Set<(m: Message) => void>();
  private actionHandlers = new Map<string, Set<(m: Message) => void>>();

  private readonly onIpc = (_: any, raw: unknown) => this.handleIncoming(raw);

  constructor(opts?: { ipcRenderer?: IpcRendererLike; pongPassword?: string }) {
    this.ipc = opts?.ipcRenderer ?? getIpcRenderer();
    this.pongPassword = opts?.pongPassword;

    this.ipc.on('transport:message', this.onIpc);
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

  async close(): Promise<void> {
    this.ipc.off('transport:message', this.onIpc);
    this.subs.clear();
    this.rawHandlers.clear();
    this.actionHandlers.clear();
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  /* eslint-disable no-empty */
  private async handleIncoming(raw: unknown) {
    const msg = normalize(raw);
    if (!msg?.action) return;

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
  try {
    const { ipcRenderer } = require('electron');
    if (!ipcRenderer) throw new Error();
    return ipcRenderer as IpcRendererLike;
  } catch {
    const maybe = (globalThis as any)?.electron?.ipcRenderer ?? (globalThis as any)?.ipcRenderer;
    if (!maybe) throw new Error('[electron-renderer] ipcRenderer not available; pass via opts.ipcRenderer');
    return maybe as IpcRendererLike;
  }
}

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
