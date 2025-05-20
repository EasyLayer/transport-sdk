import type { HttpTransportOptions } from '../transports/http.transport';
import { HttpTransport } from '../transports/http.transport';
import type { IpcTransportOptions } from '../transports/ipc.transport';
import { IpcTransport } from '../transports/ipc.transport';
import type { ITransport } from './transport';

export type TransportOptions = HttpTransportOptions | IpcTransportOptions;

/**
 * Factory for creating the correct transport implementation.
 */
export class TransportFactory {
  static create(options: TransportOptions): ITransport {
    switch (options.type) {
      case 'http':
        return new HttpTransport(options);
      case 'ipc':
        return new IpcTransport(options);
      default:
        throw new Error(`Unsupported transport kind: ${(options as any).type}`);
    }
  }
}
