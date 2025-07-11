import { TransportInitError } from '../shared';
import type { ITransport } from '../shared';
import type { HttpClientOptions } from '../transports/http';
import { HttpTransport } from '../transports/http';
import type { IpcClientOptions } from '../transports/ipc';
import { IpcTransport } from '../transports/ipc';
import type { WsClientOptions } from '../transports/ws';
import { WsTransport } from '../transports/ws';

export type ClientTransportOptions = HttpClientOptions | IpcClientOptions | WsClientOptions;

export class TransportFactory {
  static create(options: ClientTransportOptions): ITransport {
    switch (options.type) {
      case 'http':
        return new HttpTransport(options);
      case 'ipc':
        return new IpcTransport(options);
      case 'ws':
        return new WsTransport(options);
      default:
        throw new TransportInitError(`Unsupported transport type: ${(options as any).type}`, {
          transportType: (options as any).type,
          context: { supportedTypes: ['http', 'ipc', 'ws'] },
        });
    }
  }
}
