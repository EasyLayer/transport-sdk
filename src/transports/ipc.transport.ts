import type { ChildProcess } from 'node:child_process';
import type { Message } from '../core/transport';
import { BaseTransport } from '../core/transport';

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000; // 30 sec

/**
 * IPC-based transport using Node.js ChildProcess.
 */
export interface IpcTransportOptions {
  type: 'ipc';
  name?: string;
  child: ChildProcess;
}

export class IpcTransport extends BaseTransport {
  private child: ChildProcess;
  private readonly pendings = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (err: any) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private lastPingTime = 0;

  constructor(options: IpcTransportOptions) {
    super('ipc', options.name ?? 'ipc');
    this.child = options.child;
    if (!options.child.send) {
      throw new Error('ChildProcess lacks .send()');
    }
    options.child.on('message', this.onMessage.bind(this));
  }

  /** True if we’ve seen a ping within the heartbeat window. */
  isConnected(): boolean {
    return this.child.connected && Date.now() - this.lastPingTime < DEFAULT_HEARTBEAT_TIMEOUT_MS;
  }

  /** Clean up listeners and pending timers. */
  async destroy(): Promise<void> {
    this.child.off('message', this.onMessage);
    for (const { timer } of this.pendings.values()) {
      clearTimeout(timer);
    }
    this.pendings.clear();
  }

  /** Fire-and-forget: wait for connection then send. */
  protected async forward(msg: Message): Promise<void> {
    await this.waitForConnection();
    const correlationId = `${Date.now()}:${Math.random()}`;
    this.child.send({ ...msg, correlationId });
  }

  /** Send + await matching `correlationId` reply or timeout. */
  protected async transmit(msg: Message): Promise<any> {
    await this.waitForConnection();
    const correlationId = `${Date.now()}:${Math.random()}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendings.delete(correlationId);
        reject(new Error(`Timeout waiting for ${msg.action} #${correlationId}`));
      }, DEFAULT_HEARTBEAT_TIMEOUT_MS);

      this.pendings.set(correlationId, { resolve, reject, timer });
      this.child.send({ ...msg, correlationId }, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendings.delete(correlationId);
          reject(err);
        }
      });
    });
  }

  /** Poll until connection is alive or timeout. */
  private async waitForConnection(): Promise<void> {
    const start = Date.now();
    while (!this.isConnected()) {
      if (Date.now() - start > DEFAULT_HEARTBEAT_TIMEOUT_MS) {
        throw new Error('No ping from child — timeout');
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /**
   * Handle all incoming messages from child:
   * 1. Match replies to pending transmit() calls.
   * 2. Handle ping events.
   * 3. Dispatch business events.
   */
  private onMessage = (raw: any): void => {
    if (!raw || typeof raw !== 'object') return;
    const { correlationId, action, payload, requestId } = raw as any;
    if (typeof correlationId !== 'string' || typeof action !== 'string') return;

    // 1) Response to our transmit()
    if (this.pendings.has(correlationId)) {
      const { resolve, reject, timer } = this.pendings.get(correlationId)!;
      clearTimeout(timer);
      this.pendings.delete(correlationId);
      if (action === 'error') return reject(payload);
      return resolve(this.handleMessage({ action, payload, requestId }));
    }

    // 2) Unrelated pings/events
    if (action === 'ping') {
      this.lastPingTime = Date.now();
      this.child.send({ action: 'pong', correlationId });
      return;
    }
    if (action === 'event') {
      this.handleMessage({ action, payload, requestId }).catch((err) =>
        console.error('[IpcTransport] event subscriber error', err)
      );
      return;
    }

    if (action === 'batch') {
      this.handleMessage({ action, payload, requestId }).catch((err) =>
        console.error('[IpcTransport] batch subscriber error', err)
      );
      return;
    }

    console.warn(`[IpcTransport] unexpected action "${action}"`);
  };
}
