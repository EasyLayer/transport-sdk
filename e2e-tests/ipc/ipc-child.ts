import type { Envelope } from '@easylayer/transport-sdk';
import { Actions } from '@easylayer/transport-sdk';

let sawPong = false;
let sawAck = false;

let pingTimer: NodeJS.Timeout | null = null;
let batchTimer: NodeJS.Timeout | null = null;

type ControlMsg =
  | { type: 'get_status' }
  | { type: 'shutdown' };

function isControlMsg(x: unknown): x is ControlMsg {
  return Boolean(x && typeof x === 'object' && 'type' in (x as any));
}

function send(env: Envelope) {
  if (typeof process.send === 'function') process.send(env);
}

function sendPing() {
  const env: Envelope = {
    action: Actions.Ping,
    payload: { ts: Date.now(), nonce: 'n', sid: 'child' },
  };
  send(env);
}

function startPingLoop() {
  if (pingTimer) return;
  // Retry Ping until we observe Pong from the parent.
  pingTimer = setInterval(() => { if (!sawPong) sendPing(); }, 40);
}

function stopPingLoop() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

const batchEnv: Envelope = {
  action: Actions.OutboxStreamBatch,
  correlationId: 'cid-1',
  payload: {
    streamId: 's1',
    fromOffset: 0,
    toOffset: 1,
    events: [
      { id: 'e1', eventType: 'BlockAddedEvent', payload: { height: 0 } },
      { id: 'e2', eventType: 'BlockAddedEvent', payload: { height: 1 } },
    ],
  },
};

function startBatchLoop() {
  if (batchTimer) return;
  // Retry the same batch until an ACK is observed.
  batchTimer = setInterval(() => {
    if (!sawAck) send(batchEnv);
  }, 50);
}

function stopBatchLoop() {
  if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
}

// Main message handler: accepts both control messages and transport envelopes.
process.on('message', (raw: unknown) => {
  if (isControlMsg(raw)) {
    switch (raw.type) {
      case 'get_status':
        if (typeof process.send === 'function') {
          process.send({ type: 'status', pong: sawPong, ack: sawAck });
        }
        return;
      case 'shutdown':
        cleanupAndExit(0);
        return;
    }
  }

  const msg = raw as Envelope;
  switch (msg?.action) {
    case Actions.Pong: {
      // Handshake complete; stop pinging and start streaming batches.
      sawPong = true;
      stopPingLoop();
      if (!batchTimer) startBatchLoop();
      return;
    }

    case Actions.OutboxStreamAck: {
      // ACK observed; stop streaming this batch.
      sawAck = true;
      stopBatchLoop();
      return;
    }

    case Actions.QueryRequest: {
      // Reply to queries immediately.
      send({
        action: Actions.QueryResponse,
        requestId: msg.requestId,
        payload: { ok: true, data: { via: 'ipc' } },
      } as Envelope);
      return;
    }

    default:
      // Ignore unknown envelopes to be robust.
      return;
  }
});

function cleanup() {
  stopPingLoop();
  stopBatchLoop();
}

function cleanupAndExit(code: number) {
  cleanup();
  // Give the event loop a tick to flush any pending sends.
  setTimeout(() => process.exit(code), 0);
}

// Graceful shutdown hooks
process.on('disconnect', () => cleanupAndExit(0));
process.on('SIGTERM', () => cleanupAndExit(0));
process.on('SIGINT', () => cleanupAndExit(0));

// Boot sequence: start Ping retry loop and send the first Ping immediately.
startPingLoop();
sendPing();
