// Parent-side IPC transport using Node's ChildProcess messaging.
// - Listens immediately in constructor (not to miss early Ping/Batch).
// - Marks handshakeDone only after replying Pong to incoming Ping.
// - Queries are allowed only after handshakeDone.
//
// Time: O(1) per message; Space: O(1).

import type { ChildProcess } from 'node:child_process';
import type {
  Transport,
  TransportCapabilities,
  Envelope,
  BatchContext,
  OutboxStreamBatchPayload,
  OutboxStreamAckPayload,
  QueryRequestPayload,
} from '../core/transport';
import { Actions, isAction, ackActionFor, TRANSPORT_OVERHEAD_WIRE, utf8Len } from '../core/transport';

export interface IpcParentOptions {
  child: ChildProcess;
  maxMessageBytes?: number;
  connectionTimeout?: number;
}

export class IpcParentTransport implements Transport {
  private connected = true; // process can be connected even before handshake
  private handshakeDone = false;
  private rawBatchHandler: ((b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>) | null = null;
  private rawEnvelopeHandler?: (e: Envelope, ctx: BatchContext) => void;
  private readonly child: ChildProcess;
  private readonly maxBytes: number;
  private readonly connTimeout: number;

  private onMsgBound?: (env: Envelope) => void;

  constructor(opts: IpcParentOptions) {
    this.child = opts.child;
    this.maxBytes = opts.maxMessageBytes ?? 1024 * 1024;
    this.connTimeout = opts.connectionTimeout ?? 3_000;

    this.onMsgBound = (env: Envelope) =>
      this.route(env, {
        transport: 'ipc-parent',
        correlationId: env?.correlationId,
        raw: this.child,
      });
    this.child.on('message', this.onMsgBound);
  }

  kind() {
    return 'ipc-parent' as const;
  }
  capabilities(): TransportCapabilities {
    return { canQuery: true };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.onMsgBound) {
      this.child.off('message', this.onMsgBound);
      this.onMsgBound = undefined;
    }
    this.handshakeDone = false;
    this.connected = false;
  }

  isConnectedSync(): boolean {
    return this.connected && this.child.connected === true && this.handshakeDone;
  }

  async awaitConnected(timeoutMs = this.connTimeout): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isConnectedSync()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.isConnectedSync();
  }

  private async ensureConnectedOrThrow(): Promise<void> {
    const ok = await this.awaitConnected(this.connTimeout);
    if (!ok) throw new Error('[ipc-parent] not connected');
  }

  onRawBatch(h: (b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>) {
    this.rawBatchHandler = h;
  }
  onRawEnvelope(h: (e: Envelope, ctx: BatchContext) => void) {
    this.rawEnvelopeHandler = h;
  }

  private async route(env: Envelope, ctx: BatchContext) {
    if (isAction(env.action as string, 'Ping')) {
      const p: any = env.payload || {};
      const pong: Envelope = {
        action: Actions.Pong,
        timestamp: Date.now(),
        correlationId: ctx.correlationId,
        payload: { ts: p.ts ?? Date.now(), nonce: p.nonce, sid: p.sid },
      };
      if (typeof this.child.send === 'function') this.child.send(pong);
      this.handshakeDone = true;
      return;
    }

    if (isAction(env.action as string, 'OutboxStreamBatch')) {
      if (!this.rawBatchHandler) return;
      const style = (env.action as string).includes('outboxStreamBatch') ? 'camel' : 'dot';
      await this.rawBatchHandler(
        { ...(env.payload as OutboxStreamBatchPayload), _actionName: env.action as string },
        { ...ctx, actionStyle: style }
      );
      return;
    }

    if (isAction(env.action as string, 'QueryResponse')) {
      this.rawEnvelopeHandler?.(env, ctx);
      return;
    }
  }

  async ackOutbox(p: OutboxStreamAckPayload, ctx?: BatchContext): Promise<void> {
    // No size check for ACK.
    const env: Envelope<OutboxStreamAckPayload> = {
      action: ackActionFor(ctx?.actionStyle === 'camel' ? 'outboxStreamBatch' : Actions.OutboxStreamBatch),
      payload: p,
      timestamp: Date.now(),
      correlationId: ctx?.correlationId,
    };
    if (typeof this.child.send === 'function') this.child.send(env);
  }

  async query<TReq, TRes>(requestId: string, body: QueryRequestPayload<TReq>): Promise<TRes> {
    await this.ensureConnectedOrThrow();
    const env: Envelope<QueryRequestPayload<TReq>> = {
      action: Actions.QueryRequest,
      requestId,
      timestamp: Date.now(),
      payload: body,
    };
    const json = JSON.stringify(env);
    if (utf8Len(json) + TRANSPORT_OVERHEAD_WIRE > this.maxBytes) throw new Error('[ipc-parent] message too large');
    if (typeof this.child.send !== 'function') throw new Error('[ipc-parent] child.send not available');
    this.child.send(env); // fire-and-forget; Client resolves via onRawEnvelope
    return undefined as unknown as TRes;
  }
}
