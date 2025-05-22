# EasyLayer Transport SDK

A lightweight SDK for easy client-side integration with EasyLayer-based applications. 
Provides a unified interface for sending requests and subscribing to events over different transport protocols (RPC, IPC). 
Designed for seamless communication with our apps.

This document contains:

- [Setup](#setup)
- [Transport API Reference](#transport-api-reference)
  - [RPC](#rpc)
  - [IPC (Node.js Child Process)](#ipc-nodejs-child-process)
  - [WebSocket (WS)](#websocket-ws-planned)
  - [TCP](#tcp-planned)

---

<!-- SETUP-START -->
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
    type: 'rpc',
    baseUrl: 'http://localhost:3000',
  },
});

const response = await client.request('query', 'generated_requestId', {
  constructorName: 'Query_Name',
  dto: {
    modelIds: ['your_model_id'],
  },
});

// Subscribe to events (if supported by transport)
const unsubscribe = client.subscribe('Your_Event_Name', async (event) => {
  console.log('Received event:', event);
});
```
<!-- SETUP-END -->

---

<!-- TRANSPORT-API-REFERENCE-START -->

## Transport API Reference

<details>
<summary><strong>RPC</strong></summary>

#### Overview
RPC transport is used for request-response communication with our apps.  
All requests are sent as HTTP POST with a unified message envelope.

#### Configuration Example
```ts
const client = new Client({
  transport: {
    type: 'rpc',
    baseUrl: 'http://localhost:3000'
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
    "constructorName": "Query_Name",
    "dto": {
      "modelIds": ["your_model_id"]
    }
  }
}
```

#### Response Format
TODO

#### API Methods
- `client.request(action, requestId, payload)` — Send a request and await response.
- `client.subscribe(constructorName, callback)` — Not supported for RPC (will throw or be a no-op).

</details>

<details>
<summary><strong>IPC (Node.js Child Process)</strong></summary>

#### Overview
IPC transport is used for communication between Node.js processes (e.g., parent and child only).

#### Configuration Example
```ts
import { fork } from 'child_process';
const child = fork('path/to/easylayer_app');

const client = new Client({
  transport: {
    type: 'ipc',
    child,
  },
});
```

#### Message Format
Messages are sent as JSON objects:
```json
{
  "action": "query",
  "requestId": "generated_requestId",
  "payload": {
    "constructorName": "Query_Name",
    "dto": { "modelIds": ["your_model_id"] }
  }
}
```

#### Response Format
```json
{
  "action": "queryResponse",
  "requestId": "generated_requestId",
  "payload": { /* response data */ }
}
```

#### API Methods
- `client.request(action, requestId, payload)` — Send a request and await response.
- `client.subscribe(constructorName, callback)` — Subscribe to events of a given type (event-driven).

</details>

<details>
<summary><strong>WebSocket (WS)</strong> <em>(planned)</em></summary>

_Not yet implemented in this SDK. Planned for future releases._
</details>

<details>
<summary><strong>TCP</strong> <em>(planned)</em></summary>

_Not yet implemented in this SDK. Planned for future releases._
</details>

<!-- TRANSPORT-API-REFERENCE-END -->