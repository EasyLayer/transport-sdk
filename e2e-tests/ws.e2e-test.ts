import { createServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import { Client } from '@easylayer/transport-sdk';
import { Actions, type Envelope } from '@easylayer/transport-sdk';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, t = 3000) => {
  const d = Date.now() + t;
  while (Date.now() < d) { if (cond()) return; /* eslint-disable-next-line no-await-in-loop */ await sleep(20); }
  throw new Error('waitFor timeout');
};

describe('WS Node transport: hosts io server (streams) + queries app io target', () => {
  const wsListenPort = 50561; // io server for inbound streams
  const appPort = 50562;      // app io server for queries
  const host = '127.0.0.1';
  const wsUrl = `http://${host}:${wsListenPort}`;
  const appUrl = `http://${host}:${appPort}`;

  let appHttp!: ReturnType<typeof createServer>;
  let appIo!: IOServer;
  let client!: Client;

  let pusher: any; // socket.io-client.Socket
  let pingTimer: NodeJS.Timeout | null = null;
  let batchTimer: NodeJS.Timeout | null = null;

  beforeAll(async () => {
    // --- Application socket.io server for Query ---
    appHttp = createServer();
    appIo = new IOServer(appHttp, { path: '/socket.io' });
    await new Promise<void>(r => appHttp.listen(appPort, host, r));
    appIo.on('connection', (s) => {
      s.on('message', (env: Envelope) => {
        if (env.action === Actions.QueryRequest) {
          s.emit('message', {
            action: Actions.QueryResponse,
            requestId: env.requestId,
            payload: { ok: true, data: { via: 'ws' } },
          } as Envelope);
        }
      });
    });

    // --- SDK client with WS node transport (hosts WS server + queries app) ---
    client = new Client({
      transport: {
        type: 'ws',
        options: {
          listen: { port: wsListenPort, host, path: '/socket.io' },
          queryTarget: { url: appUrl, path: '/socket.io' },
          connectionTimeout: 2000,
        } as any,
      },
    });

    const { io } = require('socket.io-client');
    pusher = io(wsUrl, { path: '/socket.io', transports: ['websocket'], autoConnect: true });

    pusher.on('connect', () => {
      let gotPong = false;
      let gotAck = false;

      const sendPing = () =>
        pusher.emit('message', { action: Actions.Ping, correlationId: 'c1', payload: { ts: Date.now() } });

      sendPing();
      pingTimer = setInterval(() => { if (!gotPong) sendPing(); }, 40);

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
      const pushBatch = () => pusher.emit('message', batchEnv);

      pushBatch();
      batchTimer = setInterval(() => { if (!gotAck) pushBatch(); }, 50);

      const onMessage = (env: Envelope) => {
        if (env.action === Actions.Pong) gotPong = true;
        if (env.action === Actions.OutboxStreamAck) {
          gotAck = true;
          if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
        }
      };

      pusher.on('message', onMessage);

      const cleanupPusherSide = () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
        pusher.off('message', onMessage);
      };

      pusher.once('disconnect', cleanupPusherSide);
      pusher.once('close', cleanupPusherSide);
    });
  });

  afterAll(async () => {
    try {
      if (pusher) {
        pusher.removeAllListeners('message');
        pusher.removeAllListeners('connect');
        pusher.removeAllListeners('disconnect');
        pusher.removeAllListeners('close');
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
        try { pusher.disconnect(); } catch {}
        await sleep(20);
      }
    } catch {}

    try {
      if (client && (client as any).close) await (client as any).close();
      else if ((client as any)?.t?.disconnect) await (client as any).t.disconnect();
    } catch {}

    await new Promise<void>(r => appIo.close(() => r()));
    await new Promise<void>(r => appHttp.close(() => r()));

    await sleep(10);
  });

  it('receives stream batch and auto-acks; query works via app io', async () => {
    const seen: number[] = [];
    const unsub = client.subscribe('BlockAddedEvent', (e: any) =>
      seen.push(e.blockHeight ?? e.payload?.height ?? -1)
    );

    await waitFor(() => seen.length >= 3, 5000);
    expect(seen).toEqual([0, 1, 2]);
    unsub();

    const out = await client.querySimple<{}, { via: string }>('GetStatus', {});
    expect(out).toEqual({ via: 'ws' });
  }, 15000);
});
