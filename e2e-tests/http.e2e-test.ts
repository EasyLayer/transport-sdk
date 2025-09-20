import http from 'http';
import { Client } from '@easylayer/transport-sdk';
import { Actions } from '@easylayer/transport-sdk';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('HTTP e2e', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/rpc') {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
          const env = JSON.parse(body || '{}');
          if (env.action === Actions.QueryRequest) {
            const resp = {
              action: Actions.QueryResponse,
              requestId: env.requestId,
              payload: { ok: true, data: { via: 'http' } },
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(resp));
            return;
          }
          res.statusCode = 400; res.end();
        });
        return;
      }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    port = (server.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('query via HTTP returns inline QueryResponse', async () => {
    const client = new Client({
      transport: { type: 'http', options: { baseUrl: `http://127.0.0.1:${port}`, rpcPath: '/rpc' } }
    });

    const res = await client.querySimple<{}, { via: string }>('GetStatus', {});
    expect(res).toEqual({ via: 'http' });
  }, 10000);

  it('stream forwarding via injectEnvelope -> client subscription', async () => {
    // Create a client with HTTP transport but we will inject a batch locally through transport
    const client = new Client({
      transport: {
        type: 'http',
        options: {
          baseUrl: `http://127.0.0.1:${port}`,
          rpcPath: '/rpc',
          // no forwardWebhook: we will dispatch locally through injectEnvelope for test
        }
      }
    });

    const seen: number[] = [];
    client.subscribe('BlockAddedEvent', (e: any) => { seen.push(e.payload.n); });

    // We need access to transport to call injectEnvelope; in real tests you'd keep ref to transport instance.
    // For this e2e we construct a parallel HttpRpcClient and call injectEnvelope on it,
    // which would use client's onRawBatch via the shared transport instance in the client impl.
    // If your implementation hides transport, consider exposing a small "inject" helper for test-only builds.

    // @ts-ignore - reach into internals for test
    const transport = (client as any).t;
    const batchEnv = {
      action: Actions.OutboxStreamBatch,
      payload: {
        streamId: 's',
        fromOffset: 0,
        toOffset: 2,
        events: [
          { id: '1', eventType: 'BlockAddedEvent', payload: { n: 1 } },
          { id: '2', eventType: 'BlockAddedEvent', payload: { n: 2 } },
        ],
      },
    };

    await transport.injectEnvelope(batchEnv, { transport: 'http' });

    // allow event loop to flush handlers
    await wait(50);
    expect(seen).toEqual([1, 2]);
  }, 10000);
});
