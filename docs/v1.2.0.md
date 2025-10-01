# EasyLayer Transport SDK

A unified SDK for communicating with EasyLayer applications over different transports:
**HTTP, WebSocket, IPC (parent/child), and Electron renderer.**

---

## Installation

```bash
npm install @easylayer/transport-sdk
# or
yarn add @easylayer/transport-sdk
```

---

## Quick Start

```ts
import { Client } from '@easylayer/transport-sdk';

// Example: HTTP transport
const client = new Client({
  transport: {
    type: 'http',
    inbound: { webhookUrl: 'http://0.0.0.0:3001/events', token: 't' },
    query:   { baseUrl: 'http://server:3000' },
  },
});

// Subscribe to an event
const off = client.subscribe('UserCreated', (evt) => {
  console.log('New user event:', evt);
});

// Run a query
const res = await client.query('GetUser', { id: 1 });
console.log('User:', res);

// Unsubscribe
off();

// Close
await client.close();
```

---

## Client API

| Method | Description |
|--------|-------------|
| `subscribe(eventType, handler)` | Subscribe to events. Returns unsubscribe function. |
| `query(name, dto, timeoutMs?)` | Send query and await response. |
| `nodeHttpHandler()` | For HTTP: returns Node.js request handler. |
| `expressRouter()` | For HTTP: returns Express router. |
| `attachWs(socket)` | For WebSocket: attach an existing socket. |
| `connect()` | For WebSocket: open a managed connection. |
| `close()` | Close the active transport. |

---

## Usage per Transport

### HTTP

```ts
import { createServer } from 'http';
import { Client } from '@easylayer/transport-sdk';

const c = new Client({
  transport: {
    type: 'http',
    inbound: { webhookUrl: 'http://localhost:3001/events', token: 't' },
    query:   { baseUrl: 'http://localhost:3000' },
  },
});

// Mount as Node handler
createServer(c.nodeHttpHandler()).listen(3001);

// or mount as Express
app.use(c.expressRouter());

// Subscribe + query
c.subscribe('OrderPlaced', (evt) => console.log('Order event:', evt));
const res = await c.query('GetOrder', { orderId: 42 });
```

---

### WebSocket

```ts
import { Client } from '@easylayer/transport-sdk';

const c = new Client({
  transport: {
    type: 'ws',
    options: { url: 'wss://server:8443', token: 'abc' },
  },
});

// Managed mode
await c.connect();

// Subscribe + query
c.subscribe('MessageReceived', (evt) => console.log('Got message:', evt));
const res = await c.query('FetchMessages', { channelId: 1 });

// Close
await c.close();
```

Attach an existing socket:

```ts
const ws = new WebSocket('wss://server:8443');
const c2 = new Client({ transport: { type: 'ws', options: {} } });
c2.attachWs(ws);
```

---

### IPC Parent

```ts
import { fork } from 'child_process';
import { Client } from '@easylayer/transport-sdk';

const child = fork('child.js', { stdio: ['inherit','inherit','inherit','ipc'] });

const c = new Client({
  transport: { type: 'ipc-parent', options: { child } },
});

// Subscribe + query
c.subscribe('JobFinished', (evt) => console.log('Child finished:', evt));
const res = await c.query('RunTask', { input: 'data' });
```

---

### IPC Child

```ts
// in child.js
import { Client } from '@easylayer/transport-sdk';

const c = new Client({
  transport: { type: 'ipc-child', options: {} },
});

// Subscribe + query
c.subscribe('ConfigUpdated', (evt) => console.log('Config received:', evt));
const res = await c.query('GetConfig', {});
```

---

### Electron Renderer

```ts
import { Client } from '@easylayer/transport-sdk';

// in renderer
const c = new Client({
  transport: { type: 'electron-ipc-renderer', options: { pongPassword: 'pw' } },
});

// Subscribe + query
c.subscribe('WindowEvent', (evt) => console.log('Event from main:', evt));
const res = await c.query('GetMainState', {});
```

---

## Event Handling Rules

- One handler per event type.  
- Events of the same type are processed sequentially.  
- Different event types are processed in parallel.  
- If no handler is registered, the event is ignored (still ACKed).  

---

## Closing

Always call `close()` when the transport is no longer needed:

```ts
await client.close();
```
