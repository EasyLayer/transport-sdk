import type { Transport } from './shared';
import type { WsClientOptions } from './transports/ws';
import { WsClientTransport } from './transports/ws';
import type { HttpClientOptions } from './transports/http';
import { HttpClientTransport } from './transports/http';
import type { IpcClientOptions } from './transports/ipc';
import { IpcClientTransport } from './transports/ipc';

export type TransportConfig =
  | ({ type: 'ws' } & WsClientOptions)
  | ({ type: 'http' } & HttpClientOptions)
  | ({ type: 'ipc' } & IpcClientOptions);

export function createTransport(config: TransportConfig): Transport {
  switch (config.type) {
    case 'ws':
      return new WsClientTransport(config);
    case 'http':
      return new HttpClientTransport(config);
    case 'ipc':
      return new IpcClientTransport(config);
    default:
      throw new Error(`Unknown transport type`);
  }
}
