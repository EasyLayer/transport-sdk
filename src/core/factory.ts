import type { RpcTransportOptions } from '../transports/rpc.transport';
import { RpcTransport } from '../transports/rpc.transport';
import type { IpcTransportOptions } from '../transports/ipc.transport';
import { IpcTransport } from '../transports/ipc.transport';
import type { ITransport } from './transport';

export type TransportOptions = RpcTransportOptions | IpcTransportOptions;

/**
 * Factory for creating the correct transport implementation.
 */
export class TransportFactory {
  static create(options: TransportOptions): ITransport {
    switch (options.type) {
      case 'rpc':
        return new RpcTransport(options);
      case 'ipc':
        return new IpcTransport(options);
      default:
        throw new Error(`Unsupported transport kind: ${(options as any).type}`);
    }
  }
}
