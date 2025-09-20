// Plain HTTP transport: synchronous RPC via POST /rpc (or a given endpoint).
//
// Note: This client does not receive streaming batches over HTTP (no push).
// For outbox consumption use WS or IPC transports.

import type {
  Transport,
  TransportOptions,
  Envelope,
  RpcRequestPayload,
  BatchHandler,
  OutboxStreamAckPayload,
} from '../shared';
import { Actions, RpcResponsePayload, TRANSPORT_OVERHEAD_WIRE, utf8Len, uuid } from '../shared';

export interface HttpClientOptions extends TransportOptions {
  baseUrl: string; // e.g., "https://host:3000"
  rpcPath?: string; // e.g., "/rpc"
  headers?: Record<string, string>;
}

export class HttpClientTransport implements Transport {
  private readonly base: string;
  private readonly path: string;
  private readonly headers: Record<string, string>;
  private readonly maxBytes: number;
  private readonly connTimeout: number;
  private readonly token?: string;

  private batchHandler: BatchHandler = async () => {};

  constructor(private readonly opts: HttpClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.path = opts.rpcPath ?? '/rpc';
    this.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    this.maxBytes = opts.maxMessageBytes ?? 1024 * 1024;
    this.connTimeout = opts.connectionTimeout ?? 5000;
    this.token = opts.token;
    if (this.token) this.headers['X-Transport-Token'] = this.token;
  }

  kind(): 'http' {
    return 'http';
  }

  async connect(): Promise<void> {
    /* stateless */
  }
  async disconnect(): Promise<void> {
    /* stateless */
  }

  isConnectedSync(): boolean {
    return true;
  }
  async awaitConnected(): Promise<boolean> {
    return true;
  }

  onBatch(handler: BatchHandler): void {
    // HTTP has no streaming: keep handler but never invoked.
    this.batchHandler = handler || (async () => {});
  }

  async ackOutbox(_payload: OutboxStreamAckPayload): Promise<void> {
    // no-op (no streaming over HTTP)
  }

  async query<TReq = unknown, TRes = unknown>(route: string, data?: TReq): Promise<TRes> {
    const correlationId = uuid();
    const env: Envelope<RpcRequestPayload> = {
      action: Actions.RpcRequest,
      correlationId,
      payload: { route, data },
      timestamp: Date.now(),
    };

    // TODO(perf): whole-envelope stringify re-escapes nested JSON values
    const serialized = JSON.stringify(env);
    const size = utf8Len(serialized) + TRANSPORT_OVERHEAD_WIRE;
    if (size > this.maxBytes) throw new Error(`[http] message too large: ${size} > ${this.maxBytes}`);

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), this.connTimeout);

    try {
      const res = await fetch(this.base + this.path, {
        method: 'POST',
        headers: this.headers,
        body: serialized,
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`[http] status ${res.status}`);
      if (json?.action !== Actions.RpcResponse || json?.correlationId !== correlationId) {
        throw new Error('[http] invalid RPC response');
      }
      if (json?.payload?.err) throw new Error(String(json.payload.err));
      return json?.payload?.data as TRes;
    } finally {
      clearTimeout(to);
    }
  }
}
