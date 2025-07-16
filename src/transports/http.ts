import type { AxiosInstance } from 'axios';
import axios from 'axios';
import https from 'https';
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
  ssl?: {
    enabled?: boolean;
    rejectUnauthorized?: boolean;
    ca?: string;
    cert?: string;
    key?: string;
  };
}

export class HttpTransport extends BaseTransport {
  private readonly axiosInstance: AxiosInstance;
  private readonly maxMessageSize: number;
  private readonly sslOptions: HttpClientOptions['ssl'];

  constructor(options: HttpClientOptions) {
    super('http', options.name ?? 'http', options);

    this.maxMessageSize = options.maxMessageSize ?? MESSAGE_SIZE_LIMITS.HTTP;
    this.sslOptions = options.ssl;

    // Auto-detect SSL from URL if not explicitly set
    const isSSL = this.sslOptions?.enabled ?? options.baseUrl.startsWith('https://');

    // Prepare axios config
    const axiosConfig: any = {
      baseURL: options.baseUrl.replace(/\/$/, ''),
      headers: options.headers,
      timeout: this.timeout,
    };

    // Add SSL configuration if using HTTPS
    if (isSSL && this.sslOptions) {
      const httpsAgentOptions: any = {
        rejectUnauthorized: this.sslOptions.rejectUnauthorized ?? true,
      };

      // Add certificate options if provided
      if (this.sslOptions.ca) {
        httpsAgentOptions.ca = this.sslOptions.ca;
      }
      if (this.sslOptions.cert) {
        httpsAgentOptions.cert = this.sslOptions.cert;
      }
      if (this.sslOptions.key) {
        httpsAgentOptions.key = this.sslOptions.key;
      }

      axiosConfig.httpsAgent = new https.Agent(httpsAgentOptions);
    }

    this.axiosInstance = axios.create(axiosConfig);

    console.log(`[${this.name}] HTTP transport configured for ${options.baseUrl} ${isSSL ? '(SSL)' : '(no SSL)'}`);
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
          ssl: this.sslOptions?.enabled || false,
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
            ssl: this.sslOptions?.enabled || false,
          },
        });
      }

      return response.data.payload || response.data;
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
          ssl: this.sslOptions?.enabled || false,
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
        context: {
          ssl: this.sslOptions?.enabled || false,
        },
      });
    }
  }

  async destroy(): Promise<void> {
    // No-op for HTTP-based transport
  }
}
