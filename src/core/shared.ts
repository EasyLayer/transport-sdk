import { Buffer } from 'buffer';

export type TransportKind = 'http' | 'ws' | 'ipc-parent' | 'ipc-child' | 'electron-ipc-renderer';

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
  /** Milliseconds since epoch */
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
/** UTF-8 byte length helper. */
export const utf8Len = (s: string) => Buffer.byteLength(s, 'utf8');

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

export function normalize(raw: unknown): Message | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Message;
    } catch {
      return null;
    }
  }
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8')) as Message;
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
