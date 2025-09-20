import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { Client } from '@easylayer/transport-sdk';
import { Actions } from '@easylayer/transport-sdk';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(20);
  }
  throw new Error('waitFor timeout');
};

function makeBatch(fromOffset = 0, toOffset = 2) {
  return {
    action: Actions.OutboxStreamBatch,
    payload: {
      streamId: 'stream1',
      fromOffset,
      toOffset,
      events: [
        { id: '1', eventType: 'BlockAddedEvent', payload: { n: 1 } },
        { id: '2', eventType: 'BlockAddedEvent', payload: { n: 2 } },
      ],
    },
  };
}

describe('WS Node e2e', () => {
  let http: ReturnType<typeof createServer>;
  let io: Server;
  let url: string;
  let client: Client | undefined;

  // Keep hard refs to all timers and sockets to ensure full cleanup.
  const serverTimers = new Set<ReturnType<typeof setInterval>>();
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    http = createServer();
    io = new Server(http, { path: '/socket.io' });
    await new Promise<void>(resolve => http.listen(0, resolve));
    const port = (http.address() as any).port;
    url = `http://127.0.0.1:${port}`;

    io.on('connection', (socket) => {
      sockets.add(socket);
      let gotPong = false;
      let gotAck = false;

      // Retry Ping loop until client replies Pong
      const ping = () => socket.emit('message', { action: Actions.Ping, payload: { ts: Date.now(), nonce: Math.random() } });
      ping();
      const pingTimer: ReturnType<typeof setInterval> = setInterval(() => { if (!gotPong) ping(); }, 40);
      serverTimers.add(pingTimer);

      // Handle client messages
      socket.on('message', (env: any) => {
        if (env?.action === Actions.Pong) {
          gotPong = true;
          return;
        }
        if (env?.action === Actions.QueryRequest) {
          socket.emit('message', {
            action: Actions.QueryResponse,
            requestId: env.requestId,
            payload: { ok: true, data: { via: 'ws' } },
          });
          return;
        }
        if (env?.action === Actions.OutboxStreamAck) {
          gotAck = true;
        }
      });

      // Retry Batch loop until ACK
      const batchEnv = makeBatch();
      const sendBatch = () => socket.emit('message', batchEnv);
      const batchTimer: ReturnType<typeof setInterval> = setInterval(() => { if (!gotAck) sendBatch(); }, 50);
      serverTimers.add(batchTimer);
      sendBatch();

      socket.on('disconnect', () => {
        sockets.delete(socket);
        try { clearInterval(pingTimer); serverTimers.delete(pingTimer); } catch {}
        try { clearInterval(batchTimer); serverTimers.delete(batchTimer); } catch {}
      });
    });
  });

  afterAll(async () => {
    // 1) Close client (and fallback: force transport disconnect if close() is missing)
    try {
      if (client && (client as any).close) {
        await (client as any).close();
      } else if (client && (client as any).t?.disconnect) {
        await (client as any).t.disconnect();
      }
    } catch {}
    client = undefined;

    // 2) Force-disconnect all server sockets and remove listeners
    try {
      for (const s of sockets) {
        s.removeAllListeners();
        // @ts-ignore force true to avoid handshake timeouts
        s.disconnect(true);
      }
      sockets.clear();
    } catch {}

    // 3) Clear any stray server timers (in case 'disconnect' didn't fire)
    for (const t of Array.from(serverTimers)) {
      try { clearInterval(t); } catch {}
      serverTimers.delete(t);
    }

    // 4) Close socket.io server then http server
    await new Promise<void>(resolve => io.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));

    // 5) Give the event loop a tick
    await sleep(10);
  });

  it('handshake, stream with ACK, and query', async () => {
    // IMPORTANT: use the transport type string your SDK expects.
    // If your node WS transport is registered as 'ws', keep 'ws'.
    // If it is 'ws-node', change to that.
    client = new Client({
      transport: { type: 'ws', options: { url, path: '/socket.io', connectionTimeout: 2000 } }
    });

    const seen: number[] = [];
    client.subscribe('BlockAddedEvent', (e: any) => { seen.push(e.payload.n); });

    // wait for batch delivered (2 events)
    await waitFor(() => seen.length >= 2, 3000);
    expect(seen).toEqual([1, 2]);

    // query round-trip
    const res = await client.querySimple<{}, { via: string }>('GetStatus', {});
    expect(res).toEqual({ via: 'ws' });
  }, 10000);
});
