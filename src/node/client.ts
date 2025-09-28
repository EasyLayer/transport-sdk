import type { QueryRequestPayload } from '../core';
import { uuid } from '../core';
import { HttpClient, type HttpInboundOptions, type HttpQueryOptions } from './http';
import { WsClient } from './ws';
import { IpcParentClient } from './ipc-parent';
import { IpcChildClient } from './ipc-child';
import { ElectronIpcRendererClient } from './electron-ipc-renderer';

/**
 * Client
 * -----------------------------------------------------------------------------
 * Unified facade for five transports:
 *   - HTTP (handlers-only):        does not start a server; gives you handlers to mount.
 *   - WS (client socket):          owns or attaches to a WebSocket connection.
 *   - IPC Parent (holds ChildProcess): communicates with a provided child.
 *   - IPC Child (runs in child):   communicates with the parent via process IPC.
 *   - Electron renderer (ipcRenderer): talks to Electron main via 'transport:message'.
 *
 * Quick usage:
 * -----------------------------------------------------------------------------
 * HTTP:
 *   const c = new Client({
 *     transport: {
 *       type: 'http',
 *       inbound: { webhookUrl: 'http://0.0.0.0:3001/webhook', pongPassword: 'pw', token: 't' },
 *       query:   { baseUrl: 'http://server:3000' },
 *     }
 *   });
 *   // mount:
 *   createServer(c.nodeHttpHandler()).listen(3001);
 *   // or:
 *   app.use(c.expressRouter());
 *   // subscribe + query:
 *   c.subscribe('UserCreated', (e) => {});
 *   const res = await c.query('GetUser', { id: 1 });
 *
 * WS:
 *   // managed
 *   const c = new Client({ transport: { type: 'ws', options: { url: 'wss://server:8443', pongPassword: 'pw', reconnect: { enabled: true } } } });
 *   await c.connect();
 *   // attached
 *   const ws = new WebSocket('wss://server:8443');
 *   const c2 = new Client({ transport: { type: 'ws', options: { pongPassword: 'pw' } } });
 *   c2.attachWs(ws);
 *
 * IPC Parent (holds child):
 *   const cp = fork('child.js', { stdio: ['inherit','inherit','inherit','ipc'] });
 *   const c = new Client({ transport: { type: 'ipc-parent', options: { child: cp, pongPassword: 'pw' } } });
 *
 * IPC Child (runs in child):
 *   // in child.js
 *   const c = new Client({ transport: { type: 'ipc-child', options: { pongPassword: 'pw' } } });
 *
 * Electron renderer:
 *   // in renderer preload/renderer
 *   const c = new Client({ transport: { type: 'electron-ipc-renderer', options: { pongPassword: 'pw' } } });
 *   // or inject ipcRenderer explicitly (for tests/sandbox):
 *   const c2 = new Client({ transport: { type: 'electron-ipc-renderer', options: { ipcRenderer, pongPassword: 'pw' } } });
 *
 * Notes:
 * - HTTP returns ACK inline; WS/IPCs/Electron send ACK as messages.
 * - Comments intentionally in English only.
 */
export class Client {
  private http?: HttpClient;
  private ws?: WsClient;
  private ipcp?: IpcParentClient;
  private ipcc?: IpcChildClient;
  private elr?: ElectronIpcRendererClient;

  constructor(
    opts:
      | { transport: { type: 'http'; inbound: HttpInboundOptions; query: HttpQueryOptions } }
      | { transport: { type: 'ws'; options: ConstructorParameters<typeof WsClient>[0] } }
      | { transport: { type: 'ipc-parent'; options: ConstructorParameters<typeof IpcParentClient>[0] } }
      | { transport: { type: 'ipc-child'; options: ConstructorParameters<typeof IpcChildClient>[0] } }
      | {
          transport: {
            type: 'electron-ipc-renderer';
            options?: ConstructorParameters<typeof ElectronIpcRendererClient>[0];
          };
        }
  ) {
    switch (opts.transport.type) {
      case 'http':
        this.http = new HttpClient(opts.transport.inbound, opts.transport.query);
        break;
      case 'ws':
        this.ws = new WsClient(opts.transport.options);
        break;
      case 'ipc-parent':
        this.ipcp = new IpcParentClient(opts.transport.options);
        break;
      case 'ipc-child':
        this.ipcc = new IpcChildClient(opts.transport.options);
        break;
      case 'electron-ipc-renderer':
        this.elr = new ElectronIpcRendererClient(opts.transport.options);
        break;
      default:
        throw new Error('[client] unknown transport');
    }
  }

  // ---- subscriptions ----
  subscribe<T = any>(constructorName: string, handler: (evt: T) => unknown | Promise<unknown>): () => void {
    if (this.http) return this.http.subscribe<T>(constructorName, handler);
    if (this.ws) return this.ws.subscribe<T>(constructorName, handler);
    if (this.ipcp) return this.ipcp.subscribe<T>(constructorName, handler);
    if (this.ipcc) return this.ipcc.subscribe<T>(constructorName, handler);
    if (this.elr) return this.elr.subscribe<T>(constructorName, handler);
    throw new Error('[client] no transport');
  }
  getSubscriptionCount(constructorName: string): number {
    if (this.http) return this.http.getSubscriptionCount(constructorName);
    if (this.ws) return this.ws.getSubscriptionCount(constructorName);
    if (this.ipcp) return this.ipcp.getSubscriptionCount(constructorName);
    if (this.ipcc) return this.ipcc.getSubscriptionCount(constructorName);
    if (this.elr) return this.elr.getSubscriptionCount(constructorName);
    return 0;
  }

  // ---- query ----
  async query<TReq, TRes>(name: string, dto?: TReq, timeoutMs?: number): Promise<TRes> {
    let raw: any;
    if (this.http) raw = await this.http.query<TRes>({ name, dto });
    else if (this.ws) raw = await this.ws.query<TRes>(uuid(), { name, dto } as QueryRequestPayload, timeoutMs ?? 5_000);
    else if (this.ipcp) raw = await this.ipcp.query<TReq, TRes>(name, dto, timeoutMs ?? 5_000);
    else if (this.ipcc) raw = await this.ipcc.query<TReq, TRes>(name, dto, timeoutMs ?? 5_000);
    else if (this.elr) raw = await this.elr.query<TReq, TRes>(name, dto, timeoutMs ?? 5_000);
    else throw new Error('[client] no transport');

    return this.postProcess(name, raw) as TRes;
  }

  // ---- HTTP handlers (only when type=http) ----
  nodeHttpHandler() {
    if (!this.http) throw new Error('[client] nodeHttpHandler is HTTP-only');
    return this.http.nodeHttpHandler;
  }
  expressRouter() {
    if (!this.http) throw new Error('[client] expressRouter is HTTP-only');
    return this.http.expressRouter();
  }

  // ---- WS lifecycle helpers ----
  async connect(): Promise<void> {
    if (this.ws) return this.ws.connect();
    // Other transports do not need explicit connect
  }
  attachWs(socket: any): void {
    if (!this.ws) throw new Error('[client] attachWs is WS-only');
    this.ws.attach(socket);
  }

  async close(): Promise<void> {
    if (this.ws) return this.ws.close();
    if (this.http) return this.http.close();
    if (this.ipcp) return this.ipcp.close();
    if (this.ipcc) return this.ipcc.close();
    if (this.elr) return this.elr.close();
  }

  // ---- internal helpers ----
  private postProcess(name: string, data: any) {
    if (name === 'GetModelsQuery') {
      return this.parsePayload1D(data);
    }
    if (name === 'FetchEventsQuery') {
      return this.parsePayload1D(data);
    }
    return data;
  }

  private parsePayload1D(arr: any): any {
    if (!Array.isArray(arr)) return arr;
    return arr.map((item) => this.parseItemPayload(item));
  }

  private parsePayload2D(arr2d: any): any {
    if (!Array.isArray(arr2d)) return arr2d;
    return arr2d.map((inner) => (Array.isArray(inner) ? inner.map((item) => this.parseItemPayload(item)) : inner));
  }

  private parseItemPayload(item: any) {
    if (!item || typeof item !== 'object') return item;
    const next = { ...item };
    const p = (next as any).payload;
    if (typeof p === 'string') {
      (next as any).payload = this.safeJsonParse(p);
    }
    return next;
  }

  private safeJsonParse(s: string) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
}
