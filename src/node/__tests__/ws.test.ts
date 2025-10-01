import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { Actions } from '../../core';
import type { Message, OutboxStreamBatchPayload, WireEventRecord } from '../../core';
import { WsClient } from '../ws';

// Minimal fake WebSocket (Node 'ws'-like) for unit testing without network.
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  closed = false;

  send(data: string, cb?: (err?: Error) => void) {
    this.sent.push(String(data));
    cb?.();
  }
  close(code?: number, reason?: string) {
    this.closed = true;
    setImmediate(() => this.emit('close', code ?? 1000, reason ?? ''));
  }

  // helpers to drive inbound
  emitMessage(obj: any) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    this.emit('message', s);
  }
  openNow() {
    this.emit('open');
  }
  errorNow(err: any) {
    this.emit('error', err instanceof Error ? err : new Error(String(err)));
  }
}

function makeClientWithFakeSocket(hooks?: {
  factory?: () => FakeSocket;
}) {
  const sock = new FakeSocket();
  const factory = hooks?.factory ?? (() => sock);
  const client = new WsClient({
    url: 'ws://fake',
    processTimeoutMs: 30,
    socketFactory: factory as unknown as () => WebSocket,
  });
  return { client, sock };
}

describe('WsClient', () => {
  it('subscribe/unsubscribe & duplicate guard', async () => {
    const { client } = makeClientWithFakeSocket();
    const fn = jest.fn();
    const off = client.subscribe('E1', fn);
    expect(client.getSubscriptionCount('E1')).toBe(1);
    expect(() => client.subscribe('E1', fn)).toThrow(/duplicate/i);
    off();
    expect(client.getSubscriptionCount('E1')).toBe(0);
  });

  it('Ping → client sends Pong with password', async () => {
    const { client, sock } = makeClientWithFakeSocket();
    (client as any).pongPassword = 'pw';
    const p = client.connect();
    sock.openNow();
    await p;

    const ping: Message = { action: Actions.Ping, timestamp: Date.now() } as any;
    sock.emitMessage(ping);

    const last = sock.sent.pop()!;
    const obj = JSON.parse(last);
    expect(obj.action).toBe(Actions.Pong);
    expect(obj.payload?.password).toBe('pw');
  });

  it('OutboxStreamBatch: per-type sequential, cross-type parallel; ACK on success', async () => {
    const { client, sock } = makeClientWithFakeSocket();
    const p = client.connect();
    sock.openNow();
    await p;

    const seq: string[] = [];
    client.subscribe('A', async (e: any) => {
      seq.push(e.payload.id);
      await new Promise((r) => setTimeout(r, 5));
    });
    client.subscribe('B', async (e: any) => {
      seq.push(e.payload.id);
      await new Promise((r) => setTimeout(r, 1));
    });

    const wires: WireEventRecord[] = [
      { eventType: 'A', payload: { id: 'A1' } } as any,
      { eventType: 'B', payload: { id: 'B1' } } as any,
      { eventType: 'A', payload: { id: 'A2' } } as any,
      { eventType: 'B', payload: { id: 'B2' } } as any,
      { eventType: 'A', payload: { id: 'A3' } } as any,
    ];

    const batch: Message<OutboxStreamBatchPayload> = {
      action: Actions.OutboxStreamBatch,
      timestamp: Date.now(),
      payload: { events: wires },
    };

    sock.emitMessage(batch);
    await new Promise((r) => setTimeout(r, 50));

    expect(seq.filter((x) => x.startsWith('A'))).toEqual(['A1', 'A2', 'A3']);

    const ackRaw = sock.sent.find((s) => JSON.parse(s).action === Actions.OutboxStreamAck);
    expect(ackRaw).toBeTruthy();
    const ack = JSON.parse(ackRaw!);
    expect(ack.payload?.ok).toBe(true);
    expect(Array.isArray(ack.payload?.okIndices)).toBe(true);
    expect(ack.payload.okIndices.length).toBe(wires.length);
  });

  it('OutboxStreamBatch: timeout → NO ACK', async () => {
    const { client, sock } = makeClientWithFakeSocket();
    (client as any).processTimeoutMs = 5;
    const p = client.connect();
    sock.openNow();
    await p;

    client.subscribe('SLOW', async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const batch: Message<OutboxStreamBatchPayload> = {
      action: Actions.OutboxStreamBatch,
      timestamp: Date.now(),
      payload: { events: [{ eventType: 'SLOW', payload: {} } as any] },
    };
    sock.emitMessage(batch);

    await new Promise((r) => setTimeout(r, 30));
    const ackRaw = sock.sent.find((s) => JSON.parse(s).action === Actions.OutboxStreamAck);
    expect(ackRaw).toBeUndefined();
  });

  it('query: single-flight and response handling', async () => {
    const { client, sock } = makeClientWithFakeSocket();
    const p = client.connect();
    sock.openNow();
    await p;

    const wait = client.query<any>({ name: 'GetThing', dto: { id: 1 } });

    await expect(client.query({ name: 'Second', dto: {} })).rejects.toThrow(/in flight/i);

    const resp: Message = {
      action: Actions.QueryResponse,
      timestamp: Date.now(),
      payload: { ok: true, data: { id: 1, x: 2 } },
    } as any;
    sock.emitMessage(resp);

    const data = await wait;
    expect(data).toEqual({ id: 1, x: 2 });
  });

  it('query: payload too large error', async () => {
    const { client, sock } = makeClientWithFakeSocket();
    const p = client.connect();
    sock.openNow();
    await p;

    (client as any).maxBytes = 16;

    await expect(client.query({ name: 'Big', dto: { s: 'x'.repeat(100) } })).rejects.toThrow(/too large/i);
  });
});
