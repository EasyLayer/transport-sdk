import { Client } from '../client';

// Mock uuid so ws.query gets a stable requestId
jest.mock('../../core', () => ({
  ...jest.requireActual('../../core'),
  uuid: () => 'fixed-rid',
}));

// Prepare module mocks for every transport
const httpSubscribe = jest.fn();
const httpQuery = jest.fn();
const httpNodeHandler = () => ({} as any);
const httpExpressRouter = () => ({ use: jest.fn() } as any);
const httpClose = jest.fn();

jest.mock('../http', () => {
  return {
    HttpClient: jest.fn().mockImplementation((_inbound, _query) => ({
      subscribe: httpSubscribe,
      query: httpQuery,
      nodeHttpHandler: httpNodeHandler,
      expressRouter: httpExpressRouter,
      close: httpClose,
    })),
  };
});

const wsSubscribe = jest.fn();
const wsQuery = jest.fn();
const wsConnect = jest.fn();
const wsAttach = jest.fn();
const wsClose = jest.fn();

jest.mock('../ws', () => {
  return {
    WsClient: jest.fn().mockImplementation((_opts) => ({
      subscribe: wsSubscribe,
      query: wsQuery,
      connect: wsConnect,
      attach: wsAttach,
      close: wsClose,
    })),
  };
});

const ipcpSubscribe = jest.fn();
const ipcpQuery = jest.fn();
const ipcpClose = jest.fn();

jest.mock('../ipc-parent', () => {
  return {
    IpcParentClient: jest.fn().mockImplementation((_opts) => ({
      subscribe: ipcpSubscribe,
      query: ipcpQuery,
      close: ipcpClose,
    })),
  };
});

const ipccSubscribe = jest.fn();
const ipccQuery = jest.fn();
const ipccClose = jest.fn();

jest.mock('../ipc-child', () => {
  return {
    IpcChildClient: jest.fn().mockImplementation((_opts) => ({
      subscribe: ipccSubscribe,
      query: ipccQuery,
      close: ipccClose,
    })),
  };
});

const elrSubscribe = jest.fn();
const elrQuery = jest.fn();
const elrClose = jest.fn();

jest.mock('../electron-ipc-renderer', () => {
  return {
    ElectronIpcRendererClient: jest.fn().mockImplementation((_opts) => ({
      subscribe: elrSubscribe,
      query: elrQuery,
      close: elrClose,
    })),
  };
});

describe('Client (unit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('http: subscribe delegates to HttpClient.subscribe and returns unsubscribe fn', () => {
    const unsubscribe = jest.fn();
    httpSubscribe.mockReturnValueOnce(unsubscribe);

    const c = new Client({
      transport: {
        type: 'http',
        inbound: { webhookUrl: 'http://x/events' },
        query: { baseUrl: 'http://app' },
      },
    });

    const off = c.subscribe('UserCreated', () => {});
    expect(httpSubscribe).toHaveBeenCalledTimes(1);
    expect(httpSubscribe).toHaveBeenCalledWith('UserCreated', expect.any(Function));

    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('http: query delegates to HttpClient.query(name,dto) and returns result', async () => {
    httpQuery.mockResolvedValueOnce({ ok: true, via: 'http' });

    const c = new Client({
      transport: {
        type: 'http',
        inbound: { webhookUrl: 'http://x/events' },
        query: { baseUrl: 'http://app' },
      },
    });

    const res = await c.query('SomeQuery', { a: 1 });
    expect(httpQuery).toHaveBeenCalledTimes(1);
    expect(httpQuery).toHaveBeenCalledWith({ name: 'SomeQuery', dto: { a: 1 } });
    expect(res).toEqual({ ok: true, via: 'http' });
  });

  it('http: nodeHttpHandler() returns handler from HttpClient', () => {
    const c = new Client({
      transport: {
        type: 'http',
        inbound: { webhookUrl: 'http://x/events' },
        query: { baseUrl: 'http://app' },
      },
    });
    const handler = c.nodeHttpHandler();
    expect(handler).toBe(httpNodeHandler);
  });

  it('close() calls underlying close() of the active transport', async () => {
    const cHttp = new Client({
      transport: {
        type: 'http',
        inbound: { webhookUrl: 'http://x/events' },
        query: { baseUrl: 'http://app' },
      },
    });
    await cHttp.close();
    expect(httpClose).toHaveBeenCalledTimes(1);

    const cWs = new Client({ transport: { type: 'ws', options: {} as any } });
    await cWs.close();
    expect(wsClose).toHaveBeenCalledTimes(1);

    const cP = new Client({ transport: { type: 'ipc-parent', options: {} as any } });
    await cP.close();
    expect(ipcpClose).toHaveBeenCalledTimes(1);

    const cC = new Client({ transport: { type: 'ipc-child', options: {} as any } });
    await cC.close();
    expect(ipccClose).toHaveBeenCalledTimes(1);

    const cEl = new Client({ transport: { type: 'electron-ipc-renderer', options: {} as any } });
    await cEl.close();
    expect(elrClose).toHaveBeenCalledTimes(1);
  });
});
