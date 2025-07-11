import type { AxiosInstance } from 'axios';
import axios from 'axios';
import type { BaseTransportOptions } from '../core/transport';
import { BaseTransport } from '../core/transport';
import { ConnectionError, MessageError, MESSAGE_SIZE_LIMITS } from '../shared';
import type { IncomingMessage } from '../shared';
import { validateMessageSize } from '../shared';

export interface HttpClientOptions extends BaseTransportOptions {
  type: 'http';
  baseUrl: string;
  headers?: Record<string, string>;
  maxMessageSize?: number;
}

export class HttpTransport extends BaseTransport {
  private readonly axiosInstance: AxiosInstance;
  private readonly maxMessageSize: number;

  constructor(options: HttpClientOptions) {
    super('http', options.name ?? 'http', options);

    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.HTTP;

    this.axiosInstance = axios.create({
      baseURL: options.baseUrl.replace(/\/$/, ''),
      headers: options.headers,
      timeout: this.timeout,
    });
  }

  isConnected(): boolean {
    return true; // HTTP always "connected"
  }

  protected async forward(message: IncomingMessage): Promise<void> {
    validateMessageSize(message, this.maxMessageSize, this.type, this.name);

    try {
      await this.axiosInstance.post('', message);
    } catch (err: any) {
      throw new ConnectionError('HTTP forward failed', {
        transportType: this.type,
        transportName: this.name,
        cause: err,
        context: {
          status: err.response?.status,
          statusText: err.response?.statusText,
          action: message.action,
        },
      });
    }
  }

  protected async transmit(message: IncomingMessage): Promise<any> {
    validateMessageSize(message, this.maxMessageSize, this.type, this.name);

    try {
      // For streaming queries, use different endpoint
      if (message.action === 'streamQuery') {
        return await this.handleStreamingRequest(message);
      }

      const response = await this.axiosInstance.post('', message);

      if (!response.data) {
        throw new MessageError('Server returned empty response', {
          transportType: this.type,
          transportName: this.name,
          context: {
            status: response.status,
            action: message.action,
          },
        });
      }

      return response.data;
    } catch (err: any) {
      if (err instanceof MessageError) {
        throw err;
      }

      throw new ConnectionError('HTTP transmit failed', {
        transportType: this.type,
        transportName: this.name,
        cause: err,
        context: {
          status: err.response?.status,
          statusText: err.response?.statusText,
          action: message.action,
        },
      });
    }
  }

  private async handleStreamingRequest(message: IncomingMessage): Promise<any[]> {
    try {
      const response = await this.axiosInstance.post('/stream', message, {
        responseType: 'stream',
      });

      const results: any[] = [];
      let buffer = '';

      return new Promise((resolve, reject) => {
        response.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line

          for (const line of lines) {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.action === 'streamResponse') {
                  results.push(parsed.payload);
                } else if (parsed.action === 'streamEnd') {
                  resolve(results);
                  return;
                } else if (parsed.action === 'error') {
                  reject(new Error(parsed.payload.error));
                  return;
                }
              } catch (parseErr) {
                // Ignore parse errors in streaming
              }
            }
          }
        });

        response.data.on('end', () => {
          resolve(results);
        });

        response.data.on('error', (err: any) => {
          reject(err);
        });
      });
    } catch (err: any) {
      throw new ConnectionError('HTTP stream request failed', {
        transportType: this.type,
        transportName: this.name,
        cause: err,
      });
    }
  }

  async destroy(): Promise<void> {
    // No-op for HTTP-based transport
  }
}
