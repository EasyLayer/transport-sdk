import { Client } from '../client';
import type {
  Transport, TransportCapabilities, Envelope,
  OutboxStreamBatchPayload, OutboxStreamAckPayload, BatchContext,
  QueryRequestPayload, QueryResponsePayload,
} from '../../core';
import { Actions } from '../../core';

class MockNodeTransport implements Transport {
  public ackCalls: OutboxStreamAckPayload[] = [];
  public sentQueries: Envelope[] = [];
  public batchHandler?: (b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>;
  public envHandler?: (e: Envelope, ctx: BatchContext) => void;

  kind() { return 'ws' as any; }
  capabilities(): TransportCapabilities { return { canQuery: true }; }

  async connect() {}
  async disconnect() {}
  isConnectedSync(): boolean { return true; }
  async awaitConnected(): Promise<boolean> { return true; }

  onRawBatch(handler: (b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>) {
    this.batchHandler = handler;
  }
  onRawEnvelope(handler: (e: Envelope, ctx: BatchContext) => void): void {
    this.envHandler = handler;
  }

  async ackOutbox(p: OutboxStreamAckPayload): Promise<void> {
    this.ackCalls.push(p);
  }

  async query<TReq, TRes>(requestId: string, body: QueryRequestPayload<TReq>): Promise<TRes> {
    const env: Envelope = { action: Actions.QueryRequest, requestId, payload: body };
    this.sentQueries.push(env);
    // Simulate non-inline response: return undefined, test will deliver QueryResponse via envHandler
    return undefined as unknown as TRes;
  }
}

function makeBatch(): OutboxStreamBatchPayload {
  return {
    streamId: 's2',
    fromOffset: 0,
    toOffset: 2,
    events: [
      { id: 'e1', eventType: 'FooEvent', payload: { a: 1 } },
      { id: 'e2', eventType: 'BarEvent', payload: { b: 2 } },
    ],
    _actionName: Actions.OutboxStreamBatch,
  };
}

describe('Node Client (unit)', () => {
  it('auto-ACK then subscribers', async () => {
    const t = new MockNodeTransport();
    const client = new Client({ transport: t as unknown as Transport });

    const seen: string[] = [];
    client.subscribe('FooEvent', (evt: any) => { seen.push('Foo:' + evt.payload.a); });
    client.subscribe('BarEvent', (evt: any) => { seen.push('Bar:' + evt.payload.b); });

    await t.batchHandler!(makeBatch(), { transport: 'ws', actionStyle: 'dot' });

    expect(t.ackCalls).toHaveLength(1);
    expect(t.ackCalls[0]).toEqual({ ackFromOffset: 0, ackToOffset: 2, streamId: 's2' });
    expect(seen).toEqual(['Foo:1', 'Bar:2']);
  });

  it('query pending -> resolves on QueryResponse via onRawEnvelope', async () => {
    const t = new MockNodeTransport();
    const client = new Client({ transport: t as unknown as Transport });

    const rid = 'r-123';
    const promise = client.query<{ x: number }, { ok: true }>(rid, { constructorName: 'GetX', dto: { x: 5 } }, 200);

    // Simulate app sending QueryResponse back via envHandler
    const responsePayload: QueryResponsePayload<{ ok: true }> = { ok: true, data: { ok: true } };
    t.envHandler!(
      { action: Actions.QueryResponse, requestId: rid, payload: responsePayload },
      { transport: 'ws' }
    );

    const res = await promise;
    expect(res).toEqual({ ok: true });

    // Sent queries captured
    expect(t.sentQueries).toHaveLength(1);
    expect(t.sentQueries[0]?.action).toBe(Actions.QueryRequest);
  });

  it('query inline response path', async () => {
    class InlineTransport extends MockNodeTransport {
      async query<TReq, TRes>(requestId: string, _body: QueryRequestPayload<TReq>): Promise<TRes> {
        // return inline result -> client should not wait for onRawEnvelope
        return { ok: 1 } as unknown as TRes;
      }
    }
    const t = new InlineTransport();
    const client = new Client({ transport: t as unknown as Transport });

    const res = await client.query('rid', { constructorName: 'Inline' }, 200);
    expect(res).toEqual({ ok: 1 });
  });
});
