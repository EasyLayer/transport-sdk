import { IncomingMessage, ServerResponse } from 'node:http';
import { HttpClient } from '../http';
import { Actions } from '../../core';

function makeReq(body: any, headers: Record<string, string> = {}) {
  const req = new (class extends IncomingMessage { constructor() { super(null as any); } })() as IncomingMessage;
  req.method = 'POST';
  req.url = '/events';
  req.headers = headers;
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeClient() {
  return new HttpClient(
    { webhookUrl: 'http://localhost/events', pingUrl: 'http://localhost/ping', token: 't', processTimeoutMs: 30 },
    { baseUrl: 'http://localhost:3000' },
  );
}

describe('HttpClient (unit)', () => {
  it('ack only after sequential processing', async () => {
    const client = makeClient();
    const seen: number[] = [];
    client.subscribe('BlockAddedEvent', async (evt: any) => {
      seen.push(evt.payload.id);
      await new Promise(r => setTimeout(r, 1));
    });

    const resEnd = jest.fn();
    const res = { writeHead: jest.fn(), end: resEnd } as unknown as ServerResponse;

    const payload = {
      action: Actions.OutboxStreamBatch,
      payload: { events: [
        { eventType: 'BlockAddedEvent', payload: { id: 1 } },
        { eventType: 'BlockAddedEvent', payload: { id: 2 } },
      ]},
    };

    await client.nodeHttpHandler(makeReq(payload, { 'x-transport-token': 't' }), res);
    await new Promise(r => setTimeout(r, 5));

    expect(seen).toEqual([1, 2]);
    const ackPayload = JSON.parse(resEnd.mock.calls[0][0].toString());
    expect(ackPayload.action).toBe(Actions.OutboxStreamAck);
  });

  it('returns 401 when token missing', async () => {
    const client = makeClient();
    const res = { writeHead: jest.fn(), end: jest.fn() } as unknown as ServerResponse;
    await client.nodeHttpHandler(makeReq({ action: Actions.OutboxStreamBatch, payload: { events: [] } }), res);
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it('ignores events with no subscriber and still ACKs', async () => {
    const client = makeClient();
    const resEnd = jest.fn();
    const res = { writeHead: jest.fn(), end: resEnd } as unknown as ServerResponse;
    const payload = { action: Actions.OutboxStreamBatch, payload: { events: [{ eventType: 'Unknown', payload: {} }] } };
    await client.nodeHttpHandler(makeReq(payload, { 'x-transport-token': 't' }), res);
    expect(resEnd).toHaveBeenCalled();
  });

  it('processBatchWithTimeout rejects if handler never resolves', async () => {
    const client = makeClient();
    client.subscribe('Slow', () => new Promise(() => {}));
    await expect(
      client['processBatchWithTimeout']({ events: [{ eventType: 'Slow', payload: {} }] } as any),
    ).rejects.toThrow(/timeout/);
  });

  it('ping returns Pong and password', async () => {
    const client = new HttpClient(
      { webhookUrl: 'http://localhost/events', pingUrl: 'http://localhost/ping', pongPassword: 'pw' },
      { baseUrl: 'http://localhost:3000' },
    );
    const req = new (class extends IncomingMessage { constructor() { super(null as any); } })() as IncomingMessage;
    req.method = 'POST';
    req.url = '/ping';
    process.nextTick(() => req.emit('end'));

    const resEnd = jest.fn();
    const res = { writeHead: jest.fn(), end: resEnd } as unknown as ServerResponse;
    await client.nodeHttpHandler(req, res);
    const pong = JSON.parse(resEnd.mock.calls[0][0].toString());
    expect(pong.action).toBe(Actions.Pong);
    expect(pong.payload.password).toBe('pw');
  });
});
