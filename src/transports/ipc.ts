// Renderer/Node IPC transport.
// Two backends supported:
//  - Electron renderer: window.electron?.ipcRenderer (custom preload must expose send/on)
//  - Node child process: process.send / process.on('message')
//
// Streaming: server (parent) sends OutboxStreamBatch WITH correlationId; client MUST ACK with same correlationId.

import type {
  Transport,
  TransportOptions,
  Envelope,
  RpcRequestPayload,
  OutboxStreamBatchPayload,
  OutboxStreamAckPayload,
  WireEventRecord,
  BatchHandler,
  BatchContext,
} from '../shared';
import { Actions, RpcResponsePayload, uuid, utf8Len, TRANSPORT_OVERHEAD_WIRE } from '../shared';

type IpcBackend =
  | {
      kind: 'electron';
      send: (ch: string, data: string) => void;
      on: (ch: string, cb: (event: any, data: any) => void) => void;
      off: (ch: string, cb: any) => void;
      channel: string;
    }
  | {
      kind: 'node';
      send: (data: string) => void;
      on: (cb: (data: any) => void) => void;
      off: (cb: (data: any) => void) => void;
    };

export interface IpcClientOptions extends TransportOptions {
  channel?: string; // electron ipcRenderer channel name, default 'transport-message'
}

export class IpcClientTransport implements Transport {
  private backend: IpcBackend | null = null;
  private lastPong = 0;

  private readonly maxBytes: number;
  private readonly hbTimeout: number;
  private readonly connTimeout: number;

  private batchHandler: BatchHandler = async () => {};
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: any }>();

  private readonly onIncomingNode = (raw: any) => this.onIncoming(raw);
  private onIncomingElectron?: (evt: any, data: any) => void;

  constructor(private readonly opts: IpcClientOptions) {
    this.maxBytes = opts.maxMessageBytes ?? 1024 * 1024;
    this.hbTimeout = opts.heartbeatTimeout ?? 8000;
    this.connTimeout = opts.connectionTimeout ?? 5000;
  }

  kind(): 'ipc' {
    return 'ipc';
  }

  async connect(): Promise<void> {
    if (this.backend) return;

    // Try Electron first
    const anyWin: any = globalThis as any;
    const chan = this.opts.channel ?? 'transport-message';
    if (anyWin?.electron?.ipcRenderer?.send && anyWin?.electron?.ipcRenderer?.on) {
      const ir = anyWin.electron.ipcRenderer;
      this.backend = {
        kind: 'electron',
        send: (ch, data) => ir.send(ch, data),
        on: (ch, cb) => ir.on(ch, cb),
        off: (ch, cb) => ir.removeListener(ch, cb),
        channel: chan,
      };
      this.onIncomingElectron = (_e: any, data: any) => this.onIncoming(data);
      this.backend.on(chan, this.onIncomingElectron);
    } else if (typeof process !== 'undefined' && (process as any).send) {
      this.backend = {
        kind: 'node',
        send: (data: string) => (process as any).send!(data),
        on: (cb) => process.on('message', cb),
        off: (cb) => process.off('message', cb),
      };
      this.backend.on(this.onIncomingNode);
    } else {
      throw new Error('IPC backend not available (need electron ipcRenderer or node child process)');
    }
  }

  async disconnect(): Promise<void> {
    if (!this.backend) return;
    if (this.backend.kind === 'electron' && this.onIncomingElectron) {
      this.backend.off(this.backend.channel, this.onIncomingElectron);
    }
    if (this.backend.kind === 'node') {
      this.backend.off(this.onIncomingNode);
    }
    this.backend = null;
    // clear pending
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('disconnected'));
    }
    this.pending.clear();
  }

  isConnectedSync(): boolean {
    // In IPC we treat "channel present + recent Pong" as connected
    if (!this.backend) return false;
    const age = Date.now() - this.lastPong;
    return age < this.hbTimeout;
  }

  /* eslint-disable no-empty */
  async awaitConnected(timeoutMs: number = this.connTimeout): Promise<boolean> {
    if (this.isConnectedSync()) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isConnectedSync()) return true;
      // ask parent for ping; parent should respond
      try {
        await this.sendRaw({ action: Actions.Ping, payload: { ts: Date.now() }, timestamp: Date.now() });
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    return this.isConnectedSync();
  }
  /* eslint-enable no-empty */

  onBatch(handler: BatchHandler): void {
    this.batchHandler = handler || (async () => {});
  }

  async ackOutbox(payload: OutboxStreamAckPayload, ctx?: BatchContext): Promise<void> {
    // IPC strict path MUST echo correlationId back
    const env: Envelope<OutboxStreamAckPayload> = {
      action: Actions.OutboxStreamAck,
      payload,
      timestamp: Date.now(),
      correlationId: ctx?.correlationId,
    };
    await this.sendRaw(env);
  }

  async query<TReq = unknown, TRes = unknown>(route: string, data?: TReq): Promise<TRes> {
    const correlationId = uuid();
    const env: Envelope<RpcRequestPayload> = {
      action: Actions.RpcRequest,
      correlationId,
      payload: { route, data },
      timestamp: Date.now(),
    };
    const serialized = JSON.stringify(env); // TODO(perf): see top-level note
    const size = utf8Len(serialized) + TRANSPORT_OVERHEAD_WIRE;
    if (size > this.maxBytes) throw new Error(`[ipc] message too large: ${size} > ${this.maxBytes}`);

    await this.ensureBackend();

    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error('[ipc] RPC timeout'));
      }, this.connTimeout);

      this.pending.set(correlationId, { resolve, reject, timer });

      this.sendSerialized(serialized).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(correlationId);
        reject(e);
      });
    });
  }

  // ==== internals ====

  private async onIncoming(raw: any) {
    let msg: Envelope<any>;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }

    switch (msg.action) {
      case Actions.Ping: {
        this.lastPong = Date.now();
        await this.sendRaw({ action: Actions.Pong, payload: { ts: Date.now() }, timestamp: Date.now() });
        return;
      }
      case Actions.Pong: {
        this.lastPong = Date.now();
        return;
      }
      case Actions.RpcResponse: {
        if (msg.correlationId && this.pending.has(msg.correlationId)) {
          const p = this.pending.get(msg.correlationId)!;
          clearTimeout(p.timer);
          this.pending.delete(msg.correlationId);
          if (msg.payload?.err) p.reject(new Error(String(msg.payload.err)));
          else p.resolve(msg.payload?.data);
        }
        return;
      }
      case Actions.OutboxStreamBatch: {
        // IPC carries correlationId -> must be echoed in ACK
        const p = (msg.payload || {}) as OutboxStreamBatchPayload;
        const events: WireEventRecord[] = Array.isArray(p.events) ? p.events : [];
        const ctx: BatchContext = { correlationId: msg.correlationId };
        await this.batchHandler(events, ctx);
        return;
      }
      default:
        return;
    }
  }

  private async sendRaw<T = unknown>(env: Envelope<T>) {
    const serialized = JSON.stringify(env); // TODO(perf): see top-level note
    const size = utf8Len(serialized) + TRANSPORT_OVERHEAD_WIRE;
    if (size > this.maxBytes) throw new Error(`[ipc] message too large: ${size} > ${this.maxBytes}`);
    await this.ensureBackend();
    await this.sendSerialized(serialized);
  }

  private async sendSerialized(serialized: string) {
    await this.ensureBackend();
    if (this.backend!.kind === 'electron') {
      this.backend!.send(this.backend!['channel'], serialized);
    } else {
      this.backend!.send(serialized);
    }
  }

  private async ensureBackend() {
    if (!this.backend) throw new Error('[ipc] backend is not connected');
  }
}
