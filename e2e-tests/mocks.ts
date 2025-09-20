import type { Envelope, OutboxStreamBatchPayload, QueryRequestPayload, QueryResponsePayload } from '@easylayer/transport-sdk';
import { Actions } from '@easylayer/transport-sdk';

export function makeBatch(opts?: Partial<OutboxStreamBatchPayload>): OutboxStreamBatchPayload {
  return {
    streamId: 'stream-1',
    fromOffset: 0,
    toOffset: 2,
    events: [
      { id: 'e1', eventType: 'BlockAddedEvent', payload: { height: 0 }, timestamp: Date.now() },
      { id: 'e2', eventType: 'IgnoredEvent',    payload: { x: 1 },       timestamp: Date.now() },
      { id: 'e3', type: 'BlockAddedEvent',      payload: { height: 1 }, timestamp: Date.now() },
    ],
    ...opts,
  };
}

export function makeQueryResponse<T>(requestId: string, data: T, ok = true, err?: unknown): Envelope<QueryResponsePayload<T>> {
  return {
    action: Actions.QueryResponse,
    requestId,
    timestamp: Date.now(),
    payload: ok ? { ok: true, data } : { ok: false, err },
  };
}

export function makeQueryRequest<T>(requestId: string, body: QueryRequestPayload<T>): Envelope<QueryRequestPayload<T>> {
  return { action: Actions.QueryRequest, requestId, timestamp: Date.now(), payload: body };
}
