export type TransportKind = 'ws' | 'http' | 'ipc-parent';

export const Actions = {
  Ping: 'ping',
  Pong: 'pong',
  // canonical (dot) names for internal use and outbound defaults
  OutboxStreamBatch: 'outbox.stream.batch',
  OutboxStreamAck: 'outbox.stream.ack',
  QueryRequest: 'query.request',
  QueryResponse: 'query.response',
  // optional app-side action
  RegisterStreamConsumer: 'registerStreamConsumer',
};

export type Action = (typeof Actions)[keyof typeof Actions] | string;

/** Accept both dot and camel app-side variants for outbox batch/ack. */
const ActionSynonyms = {
  OutboxStreamBatch: new Set(['outbox.stream.batch', 'outboxStreamBatch']),
  OutboxStreamAck: new Set(['outbox.stream.ack', 'outboxStreamAck']),
  Ping: new Set(['ping']),
  Pong: new Set(['pong']),
  QueryRequest: new Set(['query.request']),
  QueryResponse: new Set(['query.response']),
  RegisterStreamConsumer: new Set(['registerStreamConsumer']),
} as const;

export function isAction(action: string | undefined, key: keyof typeof ActionSynonyms): boolean {
  return !!action && ActionSynonyms[key].has(action);
}

/** Pick ACK action name to mirror inbound batch style (camel vs dot). */
export function ackActionFor(inboundBatchAction?: string): string {
  return isAction(inboundBatchAction, 'OutboxStreamBatch') && inboundBatchAction!.includes('outboxStreamBatch')
    ? 'outboxStreamAck'
    : Actions.OutboxStreamAck;
}

export interface Envelope<T = any> {
  action: Action | string;
  timestamp?: number;
  requestId?: string;
  correlationId?: string;
  payload?: T;
}

export interface WireEventRecord {
  id: string;
  type?: string;
  eventType?: string; // preferred name to match constructor
  aggregateId?: string;
  blockHeight?: number;
  timestamp?: number;
  requestId?: string; // optional for reply-like events
  payload: unknown; // JSON string or object
}

export interface OutboxStreamBatchPayload {
  streamId?: string;
  fromOffset: number;
  toOffset: number;
  events: Array<WireEventRecord>;
  // Optionally carried by some apps; if present we mirror its style on ACK:
  _actionName?: string; // 'outboxStreamBatch' | 'outbox.stream.batch'
}

export interface OutboxStreamAckPayload {
  ackFromOffset: number;
  ackToOffset: number;
  streamId?: string;
}

export interface QueryRequestPayload<T = any> {
  constructorName: string;
  dto?: T;
}

export interface QueryResponsePayload<T = any> {
  ok: boolean;
  data?: T;
  err?: unknown;
}

export interface BatchContext {
  transport: TransportKind | string;
  raw?: unknown; // raw socket/process/req
  correlationId?: string; // propagate for ACK/Pong if upstream set it
  /** For ACK styling: 'camel' if inbound was outboxStreamBatch, 'dot' otherwise. */
  actionStyle?: 'camel' | 'dot';
}

export interface TransportCapabilities {
  canQuery: boolean;
}

export interface Transport {
  kind(): TransportKind;
  capabilities(): TransportCapabilities;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnectedSync(): boolean;
  awaitConnected(timeoutMs?: number): Promise<boolean>;

  onRawBatch(handler: (b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>): void;
  onRawEnvelope?(handler: (e: Envelope, ctx: BatchContext) => void): void;

  /** Send Outbox ACK (SDK calls this automatically after successful onRawBatch). */
  ackOutbox(p: OutboxStreamAckPayload, ctx?: BatchContext): Promise<void>;

  /** Send a query (if supported). Some transports return inline response; others resolve via onRawEnvelope. */
  query?<TReq, TRes>(requestId: string, body: QueryRequestPayload<TReq>): Promise<TRes>;
}

/** Match server-side constant (your messages.ts: 256). Safer upper bound. */
export const TRANSPORT_OVERHEAD_WIRE = 256;

/** UTF-8 length helper. */
export const utf8Len = (s: string) => Buffer.byteLength(s, 'utf8');

/** Not cryptographically strong; only for request correlation. */
export function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0,
      v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
