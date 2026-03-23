---
title: Transport SDK
sidebar_label: Transport SDK
---

# @easylayer/transport-sdk

A unified client SDK for communicating with EasyLayer applications.  
Supports **HTTP**, **WebSocket**, **IPC (parent/child)**, **Electron renderer**, and **SharedWorker** transports — with the same `subscribe` / `query` / `close` API across all of them.

---

## Installation

```bash
npm install @easylayer/transport-sdk
# or
yarn add @easylayer/transport-sdk
```

**Requirements:** Node.js ≥ 20.

The package ships separate bundles for Node.js and the browser. Your bundler or Node resolves the right entry automatically via `package.json` exports — no manual path imports needed.

---

## Concepts

Every client does two things:

- **`subscribe(eventType, handler)`** — receive domain events pushed by the server.
- **`query(name, dto?)`** — send a named query and get a response back.

Events are processed **sequentially per type** and **in parallel across types**. Only one handler per event type is allowed (duplicate registration throws). If no handler is registered for an event type, it is silently ignored and still acknowledged.

---

## Node.js Transports

Import from the root package in a Node.js environment:

```ts
import { Client } from '@easylayer/transport-sdk';
```

### HTTP

The HTTP client does not start its own HTTP server. Instead it gives you a handler to mount on your existing server. Inbound events arrive as webhook POSTs; queries go out as POST requests.

```ts
import { createServer } from 'http';
import { Client } from '@easylayer/transport-sdk';

const client = new Client({
  transport: {
    type: 'http',
    inbound: {
      webhookUrl: 'http://0.0.0.0:3001/events', // path the EasyLayer app will POST to
      token: 'secret',                           // validates X-Transport-Token header
      pongPassword: 'pw',                        // must match the server's expected password
    },
    query: {
      baseUrl: 'http://localhost:3000',          // EasyLayer app base URL
    },
  },
});

// Mount as a plain Node.js handler
createServer(client.nodeHttpHandler()).listen(3001);

// — or mount as an Express router —
// app.use(client.expressRouter());

client.subscribe('BlockConfirmed', (evt) => {
  console.log('New block:', evt.payload);
});

const result = await client.query('GetBalanceQuery', { address: '1A1z...' });
```

#### HTTP Options

| Option | Type | Default | Description |
|---|---|---|---|
| `webhookUrl` | `string` | **required** | Full URL where the server POSTs event batches. Also defines the mount path. |
| `token` | `string` | — | Validates inbound `X-Transport-Token` header. |
| `pongPassword` | `string` | — | Included in the Pong reply payload so the server accepts the connection. |
| `pingUrl` | `string` | same path as webhook | Separate path for ping, if the server uses a different endpoint. |
| `maxWireBytes` | `number` | `10485760` (10 MiB) | Maximum accepted batch size in bytes. Must match the server setting. |
| `processTimeoutMs` | `number` | `3000` | Time allowed to process a batch before sending ACK. |
| `baseUrl` | `string` | **required** | EasyLayer app base URL. Queries POST to `${baseUrl}/query`. |
| `defaultQueryTimeoutMs` | `number` | `5000` | Default query timeout. Can be overridden per-call. |

---

### WebSocket

```ts
import { Client } from '@easylayer/transport-sdk';

const client = new Client({
  transport: {
    type: 'ws',
    options: {
      url: 'wss://localhost:8443',
      token: 'secret',
      pongPassword: 'pw',
    },
  },
});

// Managed mode — opens socket and auto-reconnects on disconnect
await client.connect();

client.subscribe('BlockConfirmed', (evt) => {
  console.log('Block:', evt.payload);
});

const result = await client.query('GetBalanceQuery', { address: '1A1z...' });

await client.close();
```

**Soft start:** if the server is not reachable when `connect()` is called, it resolves immediately and reconnects in the background — your app keeps running.

#### Attach mode

Use an existing socket instead of letting the client manage it:

```ts
import WebSocket from 'ws';

const ws = new WebSocket('wss://localhost:8443');
const client = new Client({ transport: { type: 'ws', options: { url: 'wss://localhost:8443' } } });
client.attachWs(ws);
// Reconnects are your responsibility in this mode
```

#### WebSocket Options

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | **required** | WebSocket server URL. |
| `token` | `string` | — | Sent as `Sec-WebSocket-Protocol` header. |
| `clientId` | `string` | — | Optional client identifier (second subprotocol slot). |
| `pongPassword` | `string` | — | Included in Pong payload. |
| `maxWireBytes` | `number` | `10485760` | Maximum frame size in bytes. Must match server. |
| `processTimeoutMs` | `number` | `3000` | Batch processing timeout. |
| `socketFactory` | `() => WebSocket` | — | Custom factory for creating WebSocket instances in managed mode. |

---

### IPC Parent

Use when your process forks a child and needs to communicate with it over Node IPC.

```ts
import { fork } from 'child_process';
import { Client } from '@easylayer/transport-sdk';

const child = fork('./worker.js', [], {
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'], // 'ipc' is required
});

const client = new Client({
  transport: {
    type: 'ipc-parent',
    options: {
      child,
      pongPassword: 'pw',
    },
  },
});

client.subscribe('JobFinished', (evt) => {
  console.log('Job result:', evt.payload);
});

const result = await client.query('RunTaskQuery', { input: 'data' });
```

> The child **must** be spawned with `'ipc'` in `stdio`. The client validates this and throws if the channel is missing.

---

### IPC Child

The other side of the IPC pair — runs inside the forked process.

```ts
// worker.js
import { Client } from '@easylayer/transport-sdk';

const client = new Client({
  transport: {
    type: 'ipc-child',
    options: {
      pongPassword: 'pw',
    },
  },
});

client.subscribe('ConfigUpdated', (evt) => {
  console.log('New config:', evt.payload);
});

const config = await client.query('GetConfigQuery', {});
```

Parallel queries are supported on both sides via `correlationId` tracking.

---

### Electron Renderer

For use in the Electron renderer process. Communicates with the main process over the `transport:message` IPC channel.

```ts
// renderer.ts
import { Client } from '@easylayer/transport-sdk';

const client = new Client({
  transport: {
    type: 'electron-ipc-renderer',
    options: {
      pongPassword: 'pw',
      // ipcRenderer: ipcRenderer  // inject explicitly for tests or sandboxed environments
    },
  },
});

client.subscribe('AppStateChanged', (evt) => {
  console.log('State:', evt.payload);
});

const state = await client.query('GetAppStateQuery', {});
```

---

## Browser Transports

In a browser bundler environment, import from the same package root — the browser bundle is resolved automatically:

```ts
import { Client } from '@easylayer/transport-sdk';
```

### WebSocket (Browser)

```ts
const client = new Client({
  transport: {
    type: 'ws',
    options: {
      url: 'wss://api.example.com/ws',
      pongPassword: 'pw',
      reconnect: { enabled: true, minMs: 500, maxMs: 10000 },
    },
  },
});

client.subscribe('BlockConfirmed', (evt) => {
  console.log('Block:', evt.payload);
});
```

> **Note:** The browser WebSocket transport supports `subscribe` only. `query` is not available — use `shared-worker` or `electron-ipc-renderer` for query support.

#### Reconnect Options

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Enable automatic reconnection. |
| `minMs` | `number` | `500` | Minimum backoff delay in ms. |
| `maxMs` | `number` | `5000` | Maximum backoff delay in ms. |
| `factor` | `number` | `1.6` | Backoff multiplier. |
| `jitter` | `number` | `0.2` | Jitter factor (±20% of current delay). |

---

### SharedWorker

Connects a browser window to a `SharedWorker` that runs the EasyLayer crawler. Multiple tabs share the same worker instance.

```ts
const client = new Client({
  transport: {
    type: 'shared-worker',
    options: {
      url: '/worker.bundle.js',
      pongPassword: 'pw',
      queryTimeoutMs: 10000,
    },
  },
});

client.subscribe('BasicWalletDelta', (evt) => {
  console.log('Delta:', evt.payload);
});

const balance = await client.query('GetBalanceQuery', { address: '1A1z...' });

// Check if worker is alive
client.ping();
console.log('Worker online:', client.isOnline());
```

---

### Electron Renderer (Browser)

Same usage as the Node Electron renderer variant, but resolved from the browser bundle:

```ts
const client = new Client({
  transport: {
    type: 'electron-ipc-renderer',
    options: { pongPassword: 'pw' },
  },
});
```

---

## Client API

### Core Methods (all transports)

| Method | Signature | Description |
|---|---|---|
| `subscribe` | `(eventType: string, handler: (evt) => void): () => void` | Register an event handler. Returns an unsubscribe function. |
| `query` | `(name: string, dto?, timeoutMs?): Promise<T>` | Send a query, await the response. Default timeout: 5000 ms. |
| `close` | `() => Promise<void>` | Close the transport and clean up listeners. |

### Transport-specific Methods

| Method | Transport | Description |
|---|---|---|
| `connect()` | WS (Node) | Open and manage a WebSocket connection with auto-reconnect. |
| `attachWs(socket)` | WS (Node) | Attach an existing WebSocket. No internal reconnects. |
| `nodeHttpHandler()` | HTTP | Returns a Node.js `http.RequestListener` to mount. |
| `expressRouter()` | HTTP | Returns an Express `Router` to mount. |
| `ping()` | SharedWorker | Send a liveness ping to the worker. |
| `isOnline()` | Browser | Returns `true` if the transport has responded to a ping. |
| `tapRaw(handler)` | Electron, Browser WS, SharedWorker | Observe every raw incoming envelope before routing. |
| `onAction(action, handler)` | Electron, Browser WS, SharedWorker | Listen for a specific `action` string on incoming messages. |

---

## Edge Cases

**Duplicate subscriptions throw:**  
On the HTTP transport, registering two handlers for the same event type throws immediately.  
On other transports, the second handler is added to a set (multiple handlers per type are allowed in browser/Electron transports).

**Query timeout:**  
If the server does not respond within `timeoutMs` (default 5000 ms), `query()` rejects with a timeout error.  
Pass a custom timeout as the third argument: `client.query('MyQuery', dto, 15_000)`.

**`maxWireBytes` must match the server:**  
If you change `maxWireBytes` on the client, set the same value on the server-side transport. Mismatches cause batches to be rejected.

**HTTP — always mount the handler before subscribing:**  
The webhook server must be listening before the EasyLayer app starts pushing events. Start your HTTP server first, then call `subscribe`.

**IPC — child must be alive:**  
The `ipc-parent` client binds to the child at construction time. If the child exits, you must create a new `Client` with the new `ChildProcess` instance.

**WS soft start:**  
`connect()` never rejects. If the initial connection fails, it silently starts a background reconnect loop. You can start subscribing and querying immediately — operations will be deferred until the socket is ready.
