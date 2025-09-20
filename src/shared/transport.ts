// Shared contracts + base helpers for the SDK (browser/renderer/node)
//
// Memory/CPU: all (de)serialization is O(n) of payload size.
// TODO(perf): large event payloads are JSON strings inside events and will be
//             re-escaped by JSON.stringify of the whole envelope (adds CPU and some bytes).
//             Possible future fix: a custom serializer that splices raw JSON payloads
//             for `events[].payload` without re-escaping; or send compressed binary.

export const TRANSPORT_OVERHEAD_WIRE = 256 as const;

// ==== Wire contracts (mirror of backend) ====

export interface Envelope<T = unknown> {
  action: string;
  payload?: T;
  requestId?: string; // per-event idempotency (not used by SDK logic)
  correlationId?: string; // request/response pairing (IPC strict ACK / RPC)
  timestamp?: number; // ms since epoch
}

export const Actions = {
  Ping: 'ping',
  Pong: 'pong',

  RegisterStreamConsumer: 'registerStreamConsumer',

  OutboxStreamBatch: 'outboxStreamBatch',
  OutboxStreamAck: 'outboxStreamAck',

  RpcRequest: 'rpc.request',
  RpcResponse: 'rpc.response',

  Error: 'error',
} as const;

export type Action = (typeof Actions)[keyof typeof Actions];

export type PingPayload = { ts: number };
export type PongPayload = { ts: number };

export type RegisterStreamConsumerPayload = { token?: string };

export interface WireEventRecord {
  modelName: string;
  eventType: string;
  eventVersion: number;
  requestId: string;
  blockHeight: number | null;
  payload: string; // already JSON string (decompressed)
  timestamp: number;
}

export interface OutboxStreamBatchPayload {
  events: WireEventRecord[];
}

export interface OutboxStreamAckPayload {
  allOk: boolean;
  okIndices?: number[];
}

export interface RpcRequestPayload {
  route: string;
  data?: any;
}
export interface RpcResponsePayload {
  route: string;
  data?: any;
  err?: string;
}

// ==== SDK interfaces ====

export type BatchContext = {
  /** Present only for IPC strict-ACK path (server sends correlationId with batch). */
  correlationId?: string;
};

export type BatchHandler = (events: WireEventRecord[], ctx: BatchContext) => Promise<void> | void;

export interface TransportOptions {
  /** Max allowed serialized bytes; client-side guard (optional). */
  maxMessageBytes?: number;
  /** Heartbeat timeout (ms). If no Pong within this window -> considered offline. */
  heartbeatTimeout?: number;
  /** Time to wait inside awaitConnected (ms). */
  connectionTimeout?: number;
  /** Optional auth token (WS register, HTTP header, IPC userland). */
  token?: string;
  /** WS url, HTTP base url, IPC channel names, etc. Transport specific fields in derived options. */
}

export interface Transport {
  kind(): 'ws' | 'http' | 'ipc';

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /** Quick connectivity snapshot (no waiting). */
  isConnectedSync(): boolean;

  /**
   * Wait for connectivity up to the given timeout.
   * Returns true if became connected (fresh Pong or stateless success), false otherwise.
   */
  awaitConnected(timeoutMs?: number): Promise<boolean>;

  /** Send RPC and await response (preserves correlationId semantics). */
  query<TReq = unknown, TRes = unknown>(route: string, data?: TReq): Promise<TRes>;

  /**
   * Install/replace outbox batch handler.
   * For WS: ACK must be sent via `ackOutbox(...)` explicitly (or by your handler).
   * For IPC: ACK MUST include the correlationId from ctx (SDK passes it to you).
   */
  onBatch(handler: BatchHandler): void;

  /** Send ACK for the last received outbox batch. */
  ackOutbox(payload: OutboxStreamAckPayload, ctx?: BatchContext): Promise<void>;
}

// ==== Utilities ====

export function utf8Len(str: string): number {
  // O(n), no allocations; safe in browsers and node
  let s = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    s += c < 0x80 ? 1 : c < 0x800 ? 2 : (c & 0xfc00) === 0xd800 ? 4 : 3;
  }
  return s;
}

export function uuid(): string {
  // good-enough correlation id for client-side
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export type ExpIntervalController = { destroy: () => void };
export type ExpIntervalOpts = { interval: number; multiplier: number; maxInterval: number };

/**
 * Minimal exponential async interval helper:
 * - calls tick(reset) repeatedly;
 * - on reset() -> delay returns to base 'interval';
 * - delay grows by 'multiplier' up to 'maxInterval' on errors/absence of reset.
 */
export function exponentialIntervalAsync(
  tick: (reset: () => void) => Promise<void>,
  opts: ExpIntervalOpts
): ExpIntervalController {
  let destroyed = false;
  let delay = Math.max(1, opts.interval | 0);
  const mult = Math.max(1, opts.multiplier || 2);
  const maxDelay = Math.max(delay, opts.maxInterval || delay * 8);

  const loop = async () => {
    while (!destroyed) {
      let didReset = false;
      const reset = () => {
        didReset = true;
        delay = opts.interval;
      };
      try {
        await tick(reset);
      } catch {
        // keep backing off
      }
      if (!didReset) {
        delay = Math.min(maxDelay, Math.floor(delay * mult));
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  };
  loop();
  return {
    destroy: () => {
      destroyed = true;
    },
  };
}
