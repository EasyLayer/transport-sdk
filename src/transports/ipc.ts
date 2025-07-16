import type { ChildProcess } from 'node:child_process';
import type { BaseTransportOptions } from '../core/transport';
import { BaseTransport } from '../core/transport';
import {
  ConnectionError,
  TimeoutError,
  MessageError,
  TransportInitError,
  DestroyError,
  MESSAGE_SIZE_LIMITS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  validateMessageSize,
} from '../shared';
import type { IncomingMessage } from '../shared';

export interface IpcClientOptions extends BaseTransportOptions {
  type: 'ipc';
  child: ChildProcess;
  heartbeatTimeout?: number;
  maxMessageSize?: number;
}

interface IpcMessage extends IncomingMessage {
  correlationId: string;
}

export class IpcTransport extends BaseTransport {
  private child: ChildProcess;
  private readonly onMsg: (m: unknown) => void;
  private readonly heartbeatTimeout: number;
  private readonly maxMessageSize: number;
  private readonly pendings = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (err: any) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private lastPingTime = 0;
  private businessConnected = false;

  constructor(options: IpcClientOptions) {
    super('ipc', options.name ?? 'ipc', options);

    if (!options.child) {
      throw new TransportInitError('ChildProcess is required for IPC transport', {
        transportType: this.type,
      });
    }

    this.child = options.child;
    this.heartbeatTimeout = options.heartbeatTimeout ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.IPC;

    if (!options.child.send) {
      throw new TransportInitError('ChildProcess lacks .send() method', {
        transportType: this.type,
        context: { hasConnected: options.child.connected },
      });
    }

    this.onMsg = this.onMessage.bind(this);
    options.child.on('message', this.onMsg);
  }

  isConnected(): boolean {
    return this.isIpcConnected() && this.isBusinessConnected();
  }

  isIpcConnected(): boolean {
    return this.child.connected;
  }

  isBusinessConnected(): boolean {
    return this.businessConnected && Date.now() - this.lastPingTime < this.heartbeatTimeout;
  }

  async destroy(): Promise<void> {
    this.businessConnected = false;
    this.child.off('message', this.onMsg);

    Array.from(this.pendings.values()).forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(
        new DestroyError('Transport destroyed', {
          transportType: this.type,
        })
      );
    });
    this.pendings.clear();
  }

  protected async forward(msg: IncomingMessage): Promise<void> {
    await this.waitForConnection();

    const ipcMessage = this.createIpcMessage(msg);
    validateMessageSize(ipcMessage, this.maxMessageSize, this.type, this.name);
    this.child.send(ipcMessage);
  }

  protected async transmit(msg: IncomingMessage): Promise<any> {
    // IMPORTANT: Client waits for connection timeout before giving up,
    // but once connected, has separate timeout for the actual request
    await this.waitForConnection();

    const ipcMessage = this.createIpcMessage(msg);
    validateMessageSize(ipcMessage, this.maxMessageSize, this.type, this.name);

    return new Promise((resolve, reject) => {
      // Separate timeout for request itself (after connection established)
      const timer = setTimeout(() => {
        this.pendings.delete(ipcMessage.correlationId);
        reject(
          new TimeoutError(
            `No response received for ${msg.action} #${ipcMessage.correlationId} within ${this.timeout}ms`,
            this.timeout,
            {
              transportType: this.type,
              action: msg.action,
              requestId: ipcMessage.correlationId,
            }
          )
        );
      }, this.timeout);

      this.pendings.set(ipcMessage.correlationId, { resolve, reject, timer });

      this.child.send(ipcMessage, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendings.delete(ipcMessage.correlationId);
          reject(
            new ConnectionError('Failed to send IPC message', {
              transportType: this.type,
              cause: err,
              context: { correlationId: ipcMessage.correlationId, action: msg.action },
            })
          );
        }
      });
    });
  }

  private createIpcMessage(message: IncomingMessage): IpcMessage {
    return {
      ...message,
      correlationId: `${Date.now()}:${Math.random()}`,
    };
  }

  /**
   * IMPORTANT: When client starts and immediately sends query events,
   * it checks if connection is established and if not, waits for connection timeout
   * before giving up. But if connection is established during timeout, request succeeds.
   */
  private async waitForConnection(): Promise<void> {
    if (this.isConnected()) return;

    // Prevent multiple concurrent connection attempts
    if (this.connectionMutex) {
      while (this.connectionMutex && !this.isConnected()) {
        await new Promise((r) => setTimeout(r, 10));
      }
      if (this.isConnected()) return;
    }

    this.connectionMutex = true;

    try {
      const start = Date.now();
      while (!this.isConnected()) {
        if (Date.now() - start > this.heartbeatTimeout) {
          throw new ConnectionError(`No ping from child — heartbeat timeout after ${this.heartbeatTimeout}ms`, {
            transportType: this.type,
            transportName: this.name,
            context: { heartbeatTimeoutMs: this.heartbeatTimeout },
          });
        }
        await new Promise((r) => setTimeout(r, 100)); // Check every 100ms
      }
    } finally {
      this.connectionMutex = false;
    }
  }

  private onMessage(raw: any): void {
    if (!raw || typeof raw !== 'object') return;
    const { correlationId, action, payload, requestId } = raw as any;
    if (typeof correlationId !== 'string' || typeof action !== 'string') return;

    // Handle responses to pending requests
    if (this.pendings.has(correlationId)) {
      const { resolve, reject, timer } = this.pendings.get(correlationId)!;
      clearTimeout(timer);
      this.pendings.delete(correlationId);

      if (action === 'error') {
        return reject(
          new MessageError('Server returned error', {
            transportType: this.type,
            transportName: this.name,
            context: { correlationId, payload },
          })
        );
      }

      return resolve(payload);
    }

    // Handle ping/pong - business connection
    if (action === 'ping') {
      this.lastPingTime = Date.now();
      this.businessConnected = true;
      this.child.send({ action: 'pong', correlationId, requestId });
      return;
    }

    // Handle events
    if (action === 'event' || action === 'eventsBatch') {
      this.handleMessage({ action, payload, requestId }).catch(() => {
        // Silently handle errors in client
      });
      return;
    }
  }
}
