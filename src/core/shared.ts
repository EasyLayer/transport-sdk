// No longer importing Buffer from 'buffer' — all Buffer usage replaced with
// environment-safe alternatives so this file works in Node, browser, and Electron
// renderer without any polyfill requirement.

export type TransportKind = 'http' | 'ws' | 'ipc-parent' | 'ipc-child' | 'electron-ipc-renderer' | 'shared-worker';

export const Actions = {
  Ping: 'ping',
  Pong: 'pong',
  OutboxStreamBatch: 'outbox.stream.batch',
  OutboxStreamAck: 'outbox.stream.ack',
  QueryRequest: 'query.request',
  QueryResponse: 'query.response',
} as const;
export type ActionsKey = (typeof Actions)[keyof typeof Actions];

export interface Message<T = unknown> {
  action: string;
  payload?: T;
  requestId?: string;
  correlationId?: string;
  clientId?: string;
  timestamp?: number;
}

export type WireEventRecord = {
  /** Business model name that the client understands */
  modelName: string;
  /** Event constructor name */
  eventType: string;
  /** Version within aggregate */
  eventVersion: number;
  requestId: string;
  blockHeight: number | null;
  /** Serialized JSON string */
  payload: string;
  /** Microseconds since epoch (monotonic, from DomainEvent.timestamp). */
  timestamp: number;
};

export type OutboxStreamBatchPayload = { events: WireEventRecord[] };
export type OutboxStreamAckPayload = { ok: boolean; okIndices?: number[] };

export type QueryRequestPayload = { name: string; dto?: unknown };
export type QueryResponsePayload = { ok: boolean; name?: string; data?: any; err?: string };

export type DomainEvent = {
  modelName: string;
  eventType: string;
  eventVersion: number;
  requestId: string;
  blockHeight: number | null;
  timestamp: number;
  payload: any;
};

/* eslint-disable no-empty */
/** Build an object whose constructor name matches wire.eventType for string-based subscriptions. */
export function createDomainEventFromWire(wire: WireEventRecord): DomainEvent {
  const body = typeof wire.payload === 'string' ? safeParse(wire.payload) : wire.payload;

  const eventType = wire.eventType || 'UnknownEvent';
  const EventCtor: any = function () {};
  try {
    Object.defineProperty(EventCtor, 'name', { value: eventType, configurable: true });
  } catch {}

  const event: DomainEvent = {
    modelName: wire.modelName,
    eventType: wire.eventType,
    eventVersion: wire.eventVersion,
    requestId: wire.requestId,
    blockHeight: wire.blockHeight,
    timestamp: wire.timestamp,
    payload: body,
  };

  const instance = Object.assign(Object.create(EventCtor.prototype), event);
  Object.defineProperty(instance, 'constructor', { value: EventCtor, writable: false, enumerable: false });
  return instance;
}
/* eslint-enable no-empty */

export function safeParse(s: unknown) {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Must be kept in sync with the server (256). */
export const TRANSPORT_OVERHEAD_WIRE = 256;

/**
 * UTF-8 byte length of a string — works in Node, browser, and Electron renderer.
 *
 * Node:    uses Buffer.byteLength (fast, built-in).
 * Browser: uses TextEncoder (standard Web API, no polyfill needed).
 *
 * The npm 'buffer' polyfill is NOT imported here; each environment uses its
 * own native API so the shared core stays truly portable.
 */
export function utf8Len(s: string): number {
  // Node / Electron main: Buffer is available natively
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(s, 'utf8');
  }
  // Browser / Electron renderer: TextEncoder is a standard Web API (no polyfill)
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).byteLength;
  }
  // Fallback: approximate via escaped unicode (never reached in modern runtimes)
  return encodeURIComponent(s).replace(/%[0-9A-F]{2}/gi, '_').length;
}

export function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0,
      v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Deserialize a raw incoming message into a typed Message envelope.
 * Handles string (JSON), Node Buffer, ArrayBuffer (browser binary WS frames),
 * and plain objects.
 *
 * Buffer.isBuffer() is replaced with an explicit prototype check so this
 * function is safe in the browser where the npm 'buffer' polyfill's isBuffer()
 * always returns false for native Uint8Arrays.
 */
export function normalize(raw: unknown): Message | null {
  if (!raw) return null;

  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Message;
    } catch {
      return null;
    }
  }

  // Node Buffer or browser Uint8Array/Buffer-polyfill — decode as UTF-8 string
  if (raw instanceof Uint8Array) {
    try {
      const text =
        typeof TextDecoder !== 'undefined'
          ? new TextDecoder().decode(raw)
          : // Node: Uint8Array (Buffer) has toString()
            (raw as any).toString('utf8');
      return JSON.parse(text) as Message;
    } catch {
      return null;
    }
  }

  // Browser binary WebSocket frame delivered as ArrayBuffer
  if (typeof ArrayBuffer !== 'undefined' && raw instanceof ArrayBuffer) {
    try {
      return JSON.parse(new TextDecoder().decode(raw)) as Message;
    } catch {
      return null;
    }
  }

  if (typeof raw === 'object') return raw as Message;
  return null;
}

export function computeBackoff(r: { min: number; max: number; factor: number; jitter: number }): number {
  const base = r.min;
  const jitter = base * r.jitter * (Math.random() * 2 - 1); // +/- jitter
  return Math.max(50, Math.min(r.max, base + jitter));
}

/** Compute next backoff delay with jitter. Mutates state.wait. */
export function nextBackoff(state: { wait: number }, opts?: { factor?: number; max?: number; jitter?: number }) {
  const factor = Math.max(1.1, opts?.factor ?? 1.6);
  const max = Math.max(1, opts?.max ?? 300);
  const jitter = Math.max(0, opts?.jitter ?? 0.2);

  // jittered sleep duration
  const base = state.wait;
  const j = base * jitter * (Math.random() * 2 - 1);
  const sleep = Math.max(1, Math.min(max, Math.floor(base + j)));

  // update next wait
  state.wait = Math.min(max, Math.floor(base * factor));
  return sleep;
}
