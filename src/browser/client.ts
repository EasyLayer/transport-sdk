import { WsBrowserClient } from './ws-browser';
import { ElectronRendererTransport } from './electron-ipc-renderer';
import { SharedWorkerClient } from './shared-worker-client';
import type { SharedWorkerClientOptions } from './shared-worker-client';

/**
 * BrowserClient
 * -----------------------------------------------------------------------------
 * Facade over browser-side transports:
 *   - ws                    — WebSocket to a server
 *   - electron-ipc-renderer — renderer talks to Electron main
 *   - shared-worker         — window talks to a SharedWorker running the crawler
 */
export class Client {
  private ws?: WsBrowserClient;
  private el?: ElectronRendererTransport;
  private sw?: SharedWorkerClient;

  constructor(
    opts:
      | { transport: { type: 'ws'; options: ConstructorParameters<typeof WsBrowserClient>[0] } }
      | {
          transport: {
            type: 'electron-ipc-renderer';
            options?: ConstructorParameters<typeof ElectronRendererTransport>[0];
          };
        }
      | { transport: { type: 'shared-worker'; options: SharedWorkerClientOptions } }
  ) {
    switch (opts.transport.type) {
      case 'ws':
        this.ws = new WsBrowserClient(opts.transport.options);
        break;
      case 'electron-ipc-renderer':
        this.el = new ElectronRendererTransport(opts.transport.options);
        break;
      case 'shared-worker':
        this.sw = new SharedWorkerClient(opts.transport.options);
        break;
      default:
        throw new Error('[browser-client] unknown transport');
    }
  }

  subscribe<T = any>(name: string, handler: (evt: T) => unknown | Promise<unknown>): () => void {
    if (this.ws) return this.ws.subscribe<T>(name, handler);
    if (this.el) return this.el.subscribe<T>(name, handler);
    if (this.sw) return this.sw.subscribe<T>(name, handler);
    throw new Error('[browser-client] no transport');
  }

  getSubscriptionCount(name: string): number {
    if (this.ws) return this.ws.getSubscriptionCount(name);
    if (this.el) return this.el.getSubscriptionCount(name);
    if (this.sw) return this.sw.getSubscriptionCount(name);
    return 0;
  }

  async query<TReq = unknown, TRes = unknown>(name: string, dto?: TReq, timeoutMs?: number): Promise<TRes> {
    if (this.sw) return this.sw.query<TReq, TRes>(name, dto, timeoutMs);
    if (this.el) return this.el.query<TReq, TRes>(name, dto, timeoutMs);
    throw new Error(
      '[browser-client] query is not supported for ws transport — use shared-worker or electron-ipc-renderer'
    );
  }

  /** Send a ping to check SharedWorker liveness. No-op for other transports. */
  ping(): void {
    if (this.sw) return this.sw.ping();
  }

  /**
   * Whether the SharedWorker has replied to a ping recently.
   * For ws/electron-ipc-renderer returns true once constructed.
   */
  isOnline(): boolean {
    if (this.sw) return this.sw.isOnline();
    return !!(this.ws || this.el);
  }

  tapRaw(handler: (msg: any) => void): () => void {
    if (this.ws) return this.ws.tapRaw(handler);
    if (this.el) return this.el.tapRaw(handler);
    if (this.sw) return this.sw.tapRaw(handler);
    throw new Error('[browser-client] no transport');
  }

  onAction(action: string, handler: (msg: any) => void): () => void {
    if (this.ws) return this.ws.onAction(action, handler);
    if (this.el) return this.el.onAction(action, handler);
    if (this.sw) return this.sw.onAction(action, handler);
    throw new Error('[browser-client] no transport');
  }

  async close(): Promise<void> {
    if (this.ws) return this.ws.close();
    if (this.el) return this.el.close();
    if (this.sw) return this.sw.close();
  }
}
