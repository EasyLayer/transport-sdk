import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
import type { BaseTransportOptions } from '../core/transport';
import { BaseTransport } from '../core/transport';
import {
  ConnectionError,
  TimeoutError,
  TransportInitError,
  DestroyError,
  MESSAGE_SIZE_LIMITS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  validateMessageSize,
  MessageError,
} from '../shared';
import type { IncomingMessage } from '../shared';

export interface WsClientOptions extends BaseTransportOptions {
  type: 'ws';
  url: string;
  maxMessageSize?: number;
  path?: string;
  ssl?: {
    enabled?: boolean;
    rejectUnauthorized?: boolean;
    ca?: string;
    cert?: string;
    key?: string;
  };
  transports?: ('websocket' | 'polling')[];
}

export class WsTransport extends BaseTransport {
  private socket: Socket | null = null;
  private readonly url: string;
  private readonly path: string;
  private readonly heartbeatTimeout: number;
  private readonly maxMessageSize: number;
  private readonly sslOptions: WsClientOptions['ssl'];
  private readonly socketTransports: ('websocket' | 'polling')[];
  private readonly pendings = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (err: any) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private lastPongTime = 0;
  private businessConnected = false;

  constructor(options: WsClientOptions) {
    super('ws', options.name ?? 'ws', options);

    if (!options.url) {
      throw new TransportInitError('URL is required for WebSocket transport', {
        transportType: this.type,
      });
    }

    this.url = options.url;
    this.path = options.path || '/';
    this.heartbeatTimeout = DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.WS;
    this.sslOptions = options.ssl;
    this.socketTransports = options.transports || ['websocket', 'polling'];

    // Auto-detect SSL from URL if not explicitly set
    const isSSL = this.sslOptions?.enabled ?? (this.url.startsWith('https://') || this.url.startsWith('wss://'));

    console.log(
      `[${this.name}] Looking for WebSocket server at ${this.url}${this.path} ${isSSL ? '(SSL)' : '(no SSL)'}`
    );
    this.connectWebSocket();
  }

  isConnected(): boolean {
    return this.socket?.connected === true && this.businessConnected;
  }

  isWebSocketConnected(): boolean {
    return this.socket?.connected === true;
  }

  isBusinessConnected(): boolean {
    return this.businessConnected && Date.now() - this.lastPongTime < this.heartbeatTimeout;
  }

  async destroy(): Promise<void> {
    this.businessConnected = false;

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
        })
      );
    });
    this.pendings.clear();
  }

  protected async forward(msg: IncomingMessage): Promise<void> {
    if (!this.isWebSocketConnected()) {
      throw new ConnectionError('WebSocket not connected', {
        transportType: this.type,
      });
    }

    if (!this.isBusinessConnected()) {
      throw new ConnectionError('Business connection not established (no ping/pong)', {
        transportType: this.type,
      });
    }

    const requestId = `${Date.now()}:${Math.random()}`;
    const message = { ...msg, requestId };
    validateMessageSize(message, this.maxMessageSize, this.type, this.name);
    this.socket!.emit('message', message);
  }

  protected async transmit(msg: IncomingMessage): Promise<any> {
    if (!this.isWebSocketConnected()) {
      throw new ConnectionError('WebSocket not connected', {
        transportType: this.type,
      });
    }

    if (!this.isBusinessConnected()) {
      throw new ConnectionError('Business connection not established (no ping/pong)', {
        transportType: this.type,
      });
    }

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

  private connectWebSocket(): void {
    // Prepare socket.io options
    const socketOptions: any = {
      path: this.path,
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: this.socketTransports,
    };

    // Add SSL options if specified
    if (this.sslOptions) {
      socketOptions.rejectUnauthorized = this.sslOptions.rejectUnauthorized ?? true;

      // Add certificate options if provided
      if (this.sslOptions.ca || this.sslOptions.cert || this.sslOptions.key) {
        socketOptions.ca = this.sslOptions.ca;
        socketOptions.cert = this.sslOptions.cert;
        socketOptions.key = this.sslOptions.key;
      }
    }

    this.socket = io(this.url, socketOptions);

    this.socket.on('connect', () => {
      console.log(`[${this.name}] WebSocket connected to server`);
    });

    this.socket.on('connect_error', (error) => {
      console.log(`[${this.name}] Error details: ${error.message}`);
      console.log(`[${this.name}] Trying to connect to: ${this.url}${this.path}`);
    });

    this.socket.on('disconnect', (reason) => {
      console.log(`[${this.name}] WebSocket disconnected: ${reason}`);
      this.businessConnected = false;
    });

    this.socket.on('reconnect', (attemptNumber) => {
      console.log(`[${this.name}] WebSocket reconnected after ${attemptNumber} attempts to ${this.url}${this.path}`);
    });

    this.socket.on('reconnect_attempt', (attemptNumber) => {
      console.log(`[${this.name}] WebSocket reconnection attempt #${attemptNumber} to ${this.url}${this.path}`);
    });

    this.socket.on('reconnect_error', (error) => {
      console.log(`[${this.name}] WebSocket reconnection error:`, error);
    });

    this.socket.on('message', this.onMessage.bind(this));
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

    // Handle ping/pong - business connection
    if (action === 'ping') {
      this.lastPongTime = Date.now();
      this.businessConnected = true;
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
