import { Client } from '@easylayer/transport-sdk';
import { Actions, type Envelope } from '@easylayer/transport-sdk';
import { createServer } from 'node:http';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, t = 3000) => { const d = Date.now() + t; while (Date.now() < d) { if (cond()) return; await sleep(20); } throw new Error('waitFor timeout'); };

async function getFreePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as any).port as number;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

describe('HTTP Node transport: webhook (streams) + HTTP query @ /query', () => {
  let client: Client;
  let appServer: ReturnType<typeof createServer>;
  let webhookUrl: string;
  let appBaseUrl: string;

  beforeAll(async () => {
    // mock "application" RPC server at baseUrl + '/query'
    const appPort = await getFreePort();
    appBaseUrl = `http://127.0.0.1:${appPort}`;
    appServer = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/query') {
        const body = await new Promise<string>(resolve => { let b = ''; req.on('data', (c: Buffer) => (b += c)); req.on('end', () => resolve(b)); });
        const env = JSON.parse(body || '{}') as Envelope;
        const reply: Envelope = { action: Actions.QueryResponse, requestId: env.requestId, payload: { ok: true, data: { via: 'http' } } };
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply)); return;
      }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>(r => appServer.listen(appPort, '127.0.0.1', r));

    // webhook URL (transport will host the server itself). No token for simplicity.
    const hookPort = await getFreePort();
    webhookUrl = `http://127.0.0.1:${hookPort}/events`;

    // SDK client (node/http transport)
    client = new Client({
      transport: {
        type: 'http',
        options: {
          webhook: { url: webhookUrl },            // token?: 'secret' if you want to test auth header
          query:   { baseUrl: appBaseUrl },
        } as any,
      },
    });
  });

  afterAll(async () => {
    await (client as any)?.close?.();
    await new Promise<void>(r => appServer.close(() => r()));
  });

  it('GET /ping replies Pong; POST batch to webhook returns ACK and delivers events', async () => {
    // sanity: /ping
    const pingRes = await fetch(webhookUrl.replace('/events', '/ping'), { method: 'GET' });
    expect(pingRes.ok).toBe(true);
    const pong = await pingRes.json();
    expect(pong?.action).toBe(Actions.Pong);

    const seen: number[] = [];
    const unsub = client.subscribe('BlockAddedEvent', (e: any) =>
      seen.push(e.blockHeight ?? e.payload?.height ?? -1)
    );

    // simulate app -> post batch to our webhook
    const batchEnv: Envelope = {
      action: Actions.OutboxStreamBatch,
      correlationId: 'c1',
      payload: {
        streamId: 's1', fromOffset: 0, toOffset: 2,
        events: [
          { id: '1', eventType: 'BlockAddedEvent', payload: { height: 0 } },
          { id: '2', eventType: 'BlockAddedEvent', payload: { height: 1 } },
          { id: '3', eventType: 'BlockAddedEvent', payload: { height: 2 } },
        ],
      },
    };
    const res = await fetch(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batchEnv),
    });
    expect(res.ok).toBe(true);
    const ack = (await res.json()) as Envelope;
    expect(ack.action).toBe(Actions.OutboxStreamAck);

    await waitFor(() => seen.length >= 3, 3000);
    expect(seen).toEqual([0, 1, 2]);

    unsub();
  });

  it('query over HTTP (POST /query) returns inline response', async () => {
    const out = await client.querySimple<{}, { via: string }>('GetStatus', {});
    expect(out).toEqual({ via: 'http' });
  });
});
