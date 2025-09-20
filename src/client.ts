// High-level client facade that wraps a Transport.
// Responsibilities:
// - lifecycle: connect/disconnect/awaitConnected
// - streaming: set handler, provide ack helper
// - rpc: query(route,data)

import type { Transport, WireEventRecord, OutboxStreamAckPayload, BatchContext } from './shared';
import { BatchHandler } from './shared';

export class TransportClient {
  constructor(private readonly transport: Transport) {}

  kind() {
    return this.transport.kind();
  }

  async connect() {
    await this.transport.connect();
  }
  async disconnect() {
    await this.transport.disconnect();
  }

  isConnectedSync() {
    return this.transport.isConnectedSync();
  }
  awaitConnected(timeoutMs?: number) {
    return this.transport.awaitConnected(timeoutMs);
  }

  onBatch(
    handler: (
      events: WireEventRecord[],
      ctx: BatchContext,
      ack: (payload: OutboxStreamAckPayload) => Promise<void>
    ) => Promise<void> | void
  ) {
    // Wrap the provided handler to give an ack helper bound to ctx
    this.transport.onBatch(async (events: any, ctx: any) => {
      const ack = (p: OutboxStreamAckPayload) => this.transport.ackOutbox(p, ctx);
      await handler(events, ctx, ack);
    });
  }

  ackOutbox(p: OutboxStreamAckPayload, ctx?: BatchContext) {
    return this.transport.ackOutbox(p, ctx);
  }

  query<TReq = unknown, TRes = unknown>(route: string, data?: TReq): Promise<TRes> {
    return this.transport.query<TReq, TRes>(route, data);
  }
}
