import { Client } from '@easylayer/transport-sdk';
import { Actions, type Message } from '@easylayer/transport-sdk';
import { createServer } from 'node:http';

async function getFreePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as any).port as number;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, timeout = 2000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error('waitFor timeout');
};

describe('HttpClient E2E', () => {
  let client: Client;
  let server: ReturnType<typeof createServer>;
  let webhookUrl: string;

  beforeAll(async () => {
    const port = await getFreePort();
    webhookUrl = `http://127.0.0.1:${port}/events`;
    client = new Client({
      transport: { type: 'http', inbound: { webhookUrl }, query: { baseUrl: 'http://localhost:9999' } },
    });
    server = createServer(client.nodeHttpHandler());
    await new Promise<void>(r => server.listen(port, '127.0.0.1', r));
  });

  afterAll(async () => {
    await client.close();
    await new Promise<void>(r => server.close(() => r()));
  });

  it('delivers events and returns ACK', async () => {
    const seen: number[] = [];
    client.subscribe('BlockAddedEvent', (e: any) => seen.push(e.payload.height));

    const batch: Message = {
      action: Actions.OutboxStreamBatch,
      correlationId: 'c1',
      payload: { events: [
        { eventType: 'BlockAddedEvent', payload: { height: 0 } },
        { eventType: 'BlockAddedEvent', payload: { height: 1 } },
      ]},
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });

    expect(res.ok).toBe(true);
    const ack = await res.json();
    expect(ack.action).toBe(Actions.OutboxStreamAck);

    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([0, 1]);
  });
});
