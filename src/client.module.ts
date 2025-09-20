import { TransportClient } from './client';
import type { TransportConfig } from './factory';
import { createTransport } from './factory';

export function createTransportClient(cfg: TransportConfig): TransportClient {
  const t = createTransport(cfg);
  return new TransportClient(t);
}
