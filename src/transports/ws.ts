import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
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

export interface WsClientOptions extends BaseTransportOptions {
  type: 'ws';
  url: string;
  maxMessageSize?: number;
  connectionTimeout?: number;
  path?: string;
}

export class WsTransport extends BaseTransport {
  private socket: Socket | null = null;
  private readonly url: string;
  private readonly path: string;
  private readonly heartbeatTimeout: number;
  private readonly connectionTimeout: number;
  private readonly maxMessageSize: number;
  private readonly pendings = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (err: any) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private lastPongTime = 0;
  private connectPromise: Promise<void> | null = null;

  constructor(options: WsClientOptions) {
    super('ws', options.name ?? 'ws', options);

    if (!options.url) {
      throw new TransportInitError('URL is required for WebSocket transport', {
        transportType: this.type,
        transportName: this.name,
      });
    }

    this.url = options.url;
    this.path = options.path || '/socket.io';
    this.heartbeatTimeout = DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.connectionTimeout = options.connectionTimeout ?? 8000;
    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.WS;
  }

  isConnected(): boolean {
    return this.socket?.connected === true && Date.now() - this.lastPongTime < this.heartbeatTimeout;
  }

  async destroy(): Promise<void> {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    Array.from(this.pendings.values()).forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(
        new DestroyError('Transport destroyed', {
          transportType: this.type,
          transportName: this.name,
        })
      );
    });
    this.pendings.clear();
  }

  protected async forward(msg: IncomingMessage): Promise<void> {
    await this.ensureConnection();
    const requestId = `${Date.now()}:${Math.random()}`;
    const message = { ...msg, requestId };
    validateMessageSize(message, this.maxMessageSize, this.type, this.name);
    this.socket!.emit('message', message);
  }

  protected async transmit(msg: IncomingMessage): Promise<any> {
    await this.ensureConnection();
    const requestId = `${Date.now()}:${Math.random()}`;
    const message = { ...msg, requestId };
    validateMessageSize(message, this.maxMessageSize, this.type, this.name);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendings.delete(requestId);
        reject(
          new TimeoutError(
            `No response received for ${msg.action} #${requestId} within ${this.timeout}ms`,
            this.timeout,
            {
              transportType: this.type,
              transportName: this.name,
              action: msg.action,
              requestId,
            }
          )
        );
      }, this.timeout);

      this.pendings.set(requestId, { resolve, reject, timer });

      this.socket!.emit('message', message);
    });
  }

  protected async ensureConnection(): Promise<void> {
    if (this.isConnected()) return;

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const connectionTimer = setTimeout(() => {
        if (this.socket) {
          this.socket.disconnect();
        }
        reject(
          new ConnectionError(`Failed to connect to WebSocket server within ${this.connectionTimeout}ms`, {
            transportType: this.type,
            transportName: this.name,
            context: {
              connectionTimeoutMs: this.connectionTimeout,
              url: this.url,
              path: this.path,
            },
          })
        );
      }, this.connectionTimeout);

      this.socket = io(this.url, {
        path: this.path,
        autoConnect: true,
        reconnection: true,
        reconnectionAttempts: 3,
        reconnectionDelay: 1000,
        timeout: this.connectionTimeout,
        transports: ['websocket', 'polling'],
      });

      this.socket.on('connect', () => {
        clearTimeout(connectionTimer);
        this.lastPongTime = Date.now();
        resolve();
      });

      this.socket.on('connect_error', (error) => {
        clearTimeout(connectionTimer);
        reject(
          new ConnectionError('Failed to connect to WebSocket server', {
            transportType: this.type,
            transportName: this.name,
            cause: error,
            context: { url: this.url, path: this.path },
          })
        );
      });

      this.socket.on('disconnect', (reason) => {
        // console.log(`[WsTransport] Disconnected: ${reason}`);
      });

      this.socket.on('message', this.onMessage.bind(this));
    });
  }

  private onMessage = (raw: any): void => {
    if (!raw || typeof raw !== 'object') return;
    const { requestId, action, payload } = raw as any;

    if (typeof action !== 'string') return;

    // Handle responses to pending requests
    if (requestId && this.pendings.has(requestId)) {
      const { resolve, reject, timer } = this.pendings.get(requestId)!;
      clearTimeout(timer);
      this.pendings.delete(requestId);

      if (action === 'error') {
        return reject(
          new MessageError('Server returned error', {
            transportType: this.type,
            transportName: this.name,
            context: { requestId, payload },
          })
        );
      }

      if (action === 'queryResponse') {
        return resolve(payload);
      }
    }

    // Handle ping/pong
    if (action === 'ping') {
      this.lastPongTime = Date.now();
      this.socket!.emit('message', { action: 'pong', requestId });
      return;
    }

    // Handle events
    if (action === 'event' || action === 'eventsBatch') {
      this.handleMessage({ action, payload, requestId }).catch(() => {
        // Silently handle errors in client
      });
      return;
    }
  };
}
