import type { AxiosInstance } from 'axios';
import axios from 'axios';
import type { Message } from '../core/transport';
import { BaseTransport } from '../core/transport';

/**
 * HTTP-based transport.
 */
export interface HttpTransportOptions {
  type: 'http';
  baseUrl: string;
  name?: string;
  headers?: Record<string, string>;
}

export class HttpTransport extends BaseTransport {
  private readonly axiosInstance: AxiosInstance;

  constructor(options: HttpTransportOptions) {
    super('http', options.name ?? 'http');
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
      throw new Error(`HTTP forward error: ${err}`);
    });
  }

  /** Send + wait for HTTP response body. */
  protected async transmit(message: Message): Promise<any> {
    const response = await this.axiosInstance.post('', message).catch((err) => {
      throw new Error(`HTTP transmit error: ${err}`);
    });
    return response.data;
  }

  /** Nothing special to clean up for HTTP. */
  async destroy(): Promise<void> {
    /* no-op */
  }
}
