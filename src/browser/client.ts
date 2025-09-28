import { WsBrowserClient } from './ws-browser';
import { ElectronRendererTransport } from './electron-ipc-renderer';

/**
 * BrowserClient
 * -----------------------------------------------------------------------------
 * Facade over browser-side transports:
 *   - ws (WebSocket in browser)
 *   - electron-ipc-renderer (renderer talks to main)
 *
 * Capability:
 * - Subscribe to domain events by constructor name.
 * - Respond to ping with pong; reply ACK for batches.
 * - No query API (browser side acts only as sink for batches/heartbeats).
 */
export class Client {
  private ws?: WsBrowserClient;
  private el?: ElectronRendererTransport;

  constructor(
    opts:
      | { transport: { type: 'ws'; options: ConstructorParameters<typeof WsBrowserClient>[0] } }
      | {
          transport: {
            type: 'electron-ipc-renderer';
            options?: ConstructorParameters<typeof ElectronRendererTransport>[0];
          };
        }
  ) {
    switch (opts.transport.type) {
      case 'ws':
        this.ws = new WsBrowserClient(opts.transport.options);
        break;
      case 'electron-ipc-renderer':
        this.el = new ElectronRendererTransport(opts.transport.options);
        break;
      default:
        throw new Error('[browser-client] unknown transport');
    }
  }

  // Subscriptions
  subscribe<T = any>(name: string, handler: (evt: T) => unknown | Promise<unknown>): () => void {
    if (this.ws) return this.ws.subscribe<T>(name, handler);
    if (this.el) return this.el.subscribe<T>(name, handler);
    throw new Error('[browser-client] no transport');
  }
  getSubscriptionCount(name: string): number {
    if (this.ws) return this.ws.getSubscriptionCount(name);
    if (this.el) return this.el.getSubscriptionCount(name);
    return 0;
  }

  // Extensibility
  tapRaw(handler: (msg: any) => void): () => void {
    if (this.ws) return this.ws.tapRaw(handler);
    if (this.el) return this.el.tapRaw(handler);
    throw new Error('[browser-client] no transport');
  }
  onAction(action: string, handler: (msg: any) => void): () => void {
    if (this.ws) return this.ws.onAction(action, handler);
    if (this.el) return this.el.onAction(action, handler);
    throw new Error('[browser-client] no transport');
  }

  async close(): Promise<void> {
    if (this.ws) return this.ws.close();
    if (this.el) return this.el.close();
  }
}
