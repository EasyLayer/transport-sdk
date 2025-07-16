# EasyLayer Transport SDK

A lightweight SDK for easy client-side integration with EasyLayer-based applications.
Provides a unified interface for sending queries and subscribing to events over different transport protocols (HTTP, WebSocket, IPC).
Designed for seamless communication with our apps.

---

## Setup

Make sure you have [Node.js](https://nodejs.org/) (version >= 16) installed.

Install the SDK via npm or yarn:
```bash
npm install @easylayer/transport-sdk
# or
yarn add @easylayer/transport-sdk
```

### Basic Usage

```ts
import { Client } from '@easylayer/transport-sdk';

const client = new Client({
  transport: {
    type: 'http',
    baseUrl: 'http://localhost:3000',
  },
});

// Execute a query
const response = await client.query('generated_requestId', {
  constructorName: 'GetUserQuery',
  dto: {
    userId: 'user123',
  },
});

// Execute a streaming query (for supported transports)
for await (const item of client.streamQuery('stream_requestId', {
  constructorName: 'StreamDataQuery',
  dto: { limit: 100 },
})) {
  console.log('Stream item:', item);
}

// Subscribe to events (if supported by transport)
const unsubscribe = client.subscribe('UserCreatedEvent', async (event) => {
  console.log('User created:', event);
});

// Check connection status
console.log('Connected:', client.isConnected());

// Cleanup
await client.destroy();
```

### NestJS Integration

The SDK can be used as a NestJS module:

```ts
import { ClientModule } from '@easylayer/transport-sdk';

@Module({
  imports: [
    ClientModule.forRoot({
      isGlobal: true,
      transport: {
        type: 'http',
        baseUrl: 'http://localhost:3000',
      },
    }),
  ],
})
export class AppModule {}

// Or async configuration
@Module({
  imports: [
    ClientModule.forRootAsync({
      isGlobal: true,
      useFactory: (configService: ConfigService) => ({
        transport: {
          type: 'http',
          baseUrl: configService.get('API_URL'),
        },
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}

// Usage in service
@Injectable()
export class UserService {
  constructor(private readonly client: Client) {}

  async getUser(userId: string) {
    return this.client.query('req-' + Date.now(), {
      constructorName: 'GetUserQuery',
      dto: { userId },
    });
  }
}
```

---

## Transport API Reference

### HTTP Transport

#### Overview
HTTP transport is used for traditional request-response communication with EasyLayer apps.
All requests are sent as HTTP POST with a unified message envelope.

#### Configuration Options
```ts
interface HttpClientOptions {
  type: 'http';
  baseUrl: string;           // Required: Base URL of the server
  headers?: Record<string, string>; // Optional: Custom headers
  maxMessageSize?: number;   // Optional: Max message size (default: 100MB)
  timeout?: number;          // Optional: Request timeout (default: 30s)
  name?: string;            // Optional: Transport name for debugging
}
```

#### Configuration Example
```ts
const client = new Client({
  transport: {
    type: 'http',
    baseUrl: 'http://localhost:3000',
    headers: {
      'Authorization': 'Bearer token123',
      'X-API-Version': '1.0',
    },
    timeout: 10000, // 10 seconds
    maxMessageSize: 50 * 1024 * 1024, // 50MB
  },
});
```

#### Message Format
All requests are sent as POST to the base URL with the following JSON body:
```json
{
  "action": "query",
  "requestId": "generated_requestId",
  "payload": {
    "constructorName": "GetUserQuery",
    "dto": {
      "userId": "user123"
    }
  },
  "timestamp": 1640995200000
}
```

#### Response Format
```json
{
  "action": "queryResponse",
  "requestId": "generated_requestId", 
  "payload": {
    "id": "user123",
    "name": "John Doe",
    "email": "john@example.com"
  },
  "timestamp": 1640995201000,
  "responseTimestamp": 1640996201000
}
```

#### Streaming Support
For streaming queries, requests are sent to `/stream` endpoint and responses are returned as NDJSON:
```
{"action":"streamResponse","payload":{"index":0,"data":"item1"}}
{"action":"streamResponse","payload":{"index":1,"data":"item2"}}
{"action":"streamEnd","payload":null}
```

#### API Methods
- `client.query(requestId, payload)` — Send a query and await response
- `client.streamQuery(requestId, payload)` — Execute streaming query
- `client.subscribe(constructorName, callback)` — Not supported for HTTP
- `client.isConnected()` — Always returns `true` for HTTP

### WebSocket Transport

#### Overview
WebSocket transport provides real-time bidirectional communication with EasyLayer apps.
Supports queries, streaming, and event subscriptions.

#### Configuration Options
```ts
interface WsClientOptions {
  type: 'ws';
  url: string;              // Required: WebSocket server URL
  path?: string;            // Optional: Socket.IO path (default: '/socket.io')
  maxMessageSize?: number;  // Optional: Max message size (default: 10MB)
  timeout?: number;         // Optional: Request timeout (default: 30s)
  name?: string;           // Optional: Transport name for debugging
}
```

#### Configuration Example
```ts
const client = new Client({
  transport: {
    type: 'ws',
    url: 'http://localhost:3001',
    path: '/socket.io',
    maxMessageSize: 5 * 1024 * 1024, // 5MB
  },
});
```

#### Message Format
Messages are sent over WebSocket connection:
```json
{
  "action": "query",
  "requestId": "generated_requestId",
  "payload": {
    "constructorName": "GetUserQuery",
    "dto": { "userId": "user123" }
  },
  "timestamp": 1640995200000,
  "responseTimestamp": 1640996201000
}
```

#### Event Subscription
```ts
// Subscribe to events
const unsubscribe = client.subscribe('UserCreatedEvent', async (event) => {
  console.log('New user:', event);
});

// Unsubscribe
unsubscribe();
```

#### API Methods
- `client.query(requestId, payload)` — Send a query and await response
- `client.streamQuery(requestId, payload)` — Execute streaming query  
- `client.subscribe(constructorName, callback)` — Subscribe to events
- `client.isConnected()` — Check if WebSocket is connected
- `client.getSubscriptionCount(constructorName)` — Get subscription count
- `client.getActiveSubscriptions()` — Get all active subscriptions

### IPC Transport (Node.js)

#### Overview
IPC transport is used for communication between Node.js processes (parent and child).
Ideal for microservices architectures and process isolation.

#### Configuration Options
```ts
interface IpcClientOptions {
  type: 'ipc';
  child: ChildProcess;       // Required: Child process instance
  heartbeatTimeout?: number; // Optional: Heartbeat timeout (default: 30s)
  maxMessageSize?: number;   // Optional: Max message size (default: 1MB)
  timeout?: number;          // Optional: Request timeout (default: 30s)
  name?: string;            // Optional: Transport name for debugging
}
```

#### Configuration Example
```ts
import { fork } from 'child_process';

const child = fork('path/to/easylayer_app.js');
const client = new Client({
  transport: {
    type: 'ipc',
    child,
    heartbeatTimeout: 10000,
  },
});
```

#### Message Format
Messages are sent as JSON objects through IPC:
```json
{
  "action": "query",
  "requestId": "generated_request_id",
  "payload": {
    "constructorName": "GetUserQuery", 
    "dto": { "userId": "user123" }
  },
  "timestamp": 1640995200000,
  "responseTimestamp": 1640996201000
}
```

#### Response Format
```json
{
  "action": "queryResponse",
  "requestId": "generated_request_id",
  "payload": {
    "id": "user123",
    "name": "John Doe"
  },
  "timestamp": 1640995201000
}
```

#### API Methods
- `client.query(requestId, payload)` — Send a query and await response
- `client.streamQuery(requestId, payload)` — Execute streaming query
- `client.subscribe(constructorName, callback)` — Subscribe to events
- `client.isConnected()` — Check if IPC channel is connected
- `client.getSubscriptionCount(constructorName)` — Get subscription count
- `client.getActiveSubscriptions()` — Get all active subscriptions

---

## Error Handling

### Error Types

- **ConnectionError** — Network or connection issues
- **TimeoutError** — Request or connection timeouts  
- **MessageError** — Invalid messages or server errors
- **TransportInitError** — Transport configuration errors
- **MessageSizeError** — Message size limit exceeded
- **SubscriptionError** — Event subscription errors