import type { AxiosInstance } from 'axios';
import axios from 'axios';
import type { Message } from '../core/transport';
import { BaseTransport } from '../core/transport';

/**
 * RPC-based transport.
 */
export interface RpcTransportOptions {
  type: 'rpc';
  baseUrl: string;
  name?: string;
  headers?: Record<string, string>;
}

export class RpcTransport extends BaseTransport {
  private readonly axiosInstance: AxiosInstance;

  constructor(options: RpcTransportOptions) {
    super('rpc', options.name ?? 'rpc');
    // ensure no trailing slash
    this.axiosInstance = axios.create({
      baseURL: options.baseUrl.replace(/\/$/, ''),
      headers: options.headers,
      timeout: 10000,
    });
  }

  /** Fire-and-forget: POST the message. */
  protected async forward(message: Message): Promise<void> {
    await this.axiosInstance.post('', message).catch((err) => {
      throw new Error(`RPC forward error: ${err}`);
    });
  }

  /** Send + wait for RPC response body. */
  protected async transmit(message: Message): Promise<any> {
    const response = await this.axiosInstance.post('', message).catch((err) => {
      throw new Error(`RPC transmit error: ${err}`);
    });
    return response.data;
  }

  /** Nothing special to clean up for RPC. */
  async destroy(): Promise<void> {
    /* no-op */
  }
}
