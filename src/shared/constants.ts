export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_WS_PORT = 3001;

// Message size limits per transport
export const MESSAGE_SIZE_LIMITS = {
  IPC: 1 * 1024 * 1024, // 1MB for IPC
  WS: 10 * 1024 * 1024, // 10MB for WebSocket
  HTTP: 100 * 1024 * 1024, // 100MB for HTTP
} as const;
