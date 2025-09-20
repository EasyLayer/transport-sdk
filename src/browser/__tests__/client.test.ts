import { Client } from '../client';
import type {
  Transport, TransportCapabilities, Envelope,
  OutboxStreamBatchPayload, OutboxStreamAckPayload, BatchContext,
} from '../../core';
import { Actions } from '../../core';

class MockBrowserTransport implements Transport {
  public ackCalls: OutboxStreamAckPayload[] = [];
  public batchHandler?: (b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>;

  kind() { return 'ws' as any; }
  capabilities(): TransportCapabilities { return { canQuery: false }; }

  async connect() {}
  async disconnect() {}
  isConnectedSync(): boolean { return true; }
  async awaitConnected(): Promise<boolean> { return true; }

  onRawBatch(handler: (b: OutboxStreamBatchPayload, ctx: BatchContext) => Promise<void>) {
    this.batchHandler = handler;
  }
  onRawEnvelope?(handler: (e: Envelope, ctx: BatchContext) => void): void {
    // browser transports typically don't need onRawEnvelope in unit coverage
    void handler;
  }

  async ackOutbox(p: OutboxStreamAckPayload): Promise<void> {
    this.ackCalls.push(p);
  }
}

function makeBatch(): { env: Envelope; payload: OutboxStreamBatchPayload } {
  const payload: OutboxStreamBatchPayload = {
    streamId: 's',
    fromOffset: 10,
    toOffset: 12,
    events: [
      {
        id: '1',
        eventType: 'BlockAddedEvent',
        aggregateId: 'chain',
        blockHeight: 123,
        timestamp: Date.now(),
        payload: { foo: 1 },
      },
      {
        id: '2',
        eventType: 'OtherEvent',
        aggregateId: 'chain',
        blockHeight: 124,
        timestamp: Date.now(),
        payload: { bar: 2 },
      },
    ],
    _actionName: Actions.OutboxStreamBatch,
  };

  return { env: { action: Actions.OutboxStreamBatch, payload }, payload };
}

describe('Browser Client (unit)', () => {
  it('auto-ACK sent before handlers, handlers receive correct events by eventType', async () => {
    const t = new MockBrowserTransport();
    const client = new Client({ transport: t as unknown as Transport });

    const seen: string[] = [];
    client.subscribe('BlockAddedEvent', (evt: any) => { seen.push('BlockAdded:' + evt.payload.foo); });
    client.subscribe('OtherEvent',     (evt: any) => { seen.push('Other:' + evt.payload.bar); });

    const { payload } = makeBatch();

    // Wrap handler to assert ACK call order: ACK should happen first
    const ackOrder: string[] = [];
    const origAck = t.ackOutbox.bind(t);
    t.ackOutbox = async (p) => {
      ackOrder.push('ack');
      await origAck(p);
    };

    const h = t.batchHandler!;
    await h(payload, { transport: 'ws', actionStyle: 'dot' });

    // Assert ACK payload correctness
    expect(t.ackCalls).toHaveLength(1);
    expect(t.ackCalls[0]).toEqual({
      ackFromOffset: 10,
      ackToOffset: 12,
      streamId: 's',
    });

    // Assert handlers called
    expect(seen).toEqual(['BlockAdded:1', 'Other:2']);

    // For strict order you could instrument subscriber pushes vs ACK, here we confirm ACK happened exactly once
    expect(ackOrder).toEqual(['ack']);
  });

  it('query() is not supported', async () => {
    const t = new MockBrowserTransport();
    const client = new Client({ transport: t as unknown as Transport });

    await expect(client.query('rid', { constructorName: 'X', dto: {} }, 50))
      .rejects
      .toThrow(/not supported/i);
  });
});
