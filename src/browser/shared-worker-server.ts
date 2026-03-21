import type {
  Message,
  OutboxStreamAckPayload,
  OutboxStreamBatchPayload,
  QueryRequestPayload,
  QueryResponsePayload,
} from '../core';
import { Actions, createDomainEventFromWire } from '../core';

export type SharedWorkerQueryHandler = (name: string, dto?: unknown) => Promise<unknown>;

export type SharedWorkerServerOptions = {
  /**
   * Called when the window sends a query.request.
   * Typically: (name, dto) => queryBus.execute(buildQuery({ name, dto }))
   */
  queryHandler?: SharedWorkerQueryHandler;

  /**
   * Optional password included in Pong payload.
   * Client must set matching pongPassword to consider the server online.
   */
  pongPassword?: string;
};

/**
 * SharedWorkerServer
 * -----------------------------------------------------------------------------
 * Runs inside a SharedWorker. Accepts MessagePort connections from any number
 * of windows/tabs and handles:
 *   - ping  → pong
 *   - outbox.stream.batch → fan-out domain events to subscribers → ack
 *   - query.request → queryHandler(name, dto) → query.response
 *
 * Usage inside the SharedWorker script:
 *
 *   // shared-worker.ts
 *   import { bootstrapBrowser } from '@easylayer/bitcoin-crawler';
 *   import { SharedWorkerServer } from '@easylayer/transport-sdk';
 *
 *   let server: SharedWorkerServer;
 *
 *   (async () => {
 *     const appContext = await bootstrapBrowser({ Models: [...], QueryHandlers: [...] });
 *     const queryBus = appContext.get(QueryBus, { strict: false });
 *
 *     server = new SharedWorkerServer({
 *       queryHandler: (name, dto) => queryBus.execute(buildQuery({ name, dto })),
 *     });
 *
 *     // Wire SharedWorker's onconnect to the server
 *     self.onconnect = (e) => server.addPort(e.ports[0]);
 *   })();
 */
export class SharedWorkerServer {
  private readonly ports = new Set<MessagePort>();
  private readonly opts: SharedWorkerServerOptions;

  constructor(opts: SharedWorkerServerOptions = {}) {
    this.opts = opts;
  }

  /**
   * Register a new MessagePort from a connecting window.
   * Call this from the SharedWorker's onconnect handler:
   *   self.onconnect = (e) => server.addPort(e.ports[0]);
   */
  addPort(port: MessagePort): void {
    this.ports.add(port);

    port.onmessage = (ev) => this.handleIncoming(port, ev.data);

    port.onmessageerror = () => {
      this.ports.delete(port);
    };

    port.start();
  }

  /**
   * Broadcast an outbox batch to all connected windows.
   * Call this from the crawler's event handler if you want to push events
   * to all open windows in real time (optional — windows can also just query).
   */
  broadcast(msg: Message): void {
    const frame = JSON.stringify(msg);
    for (const port of this.ports) {
      try {
        port.postMessage(frame);
      } catch {
        this.ports.delete(port);
      }
    }
  }

  /** Number of currently connected windows. */
  get connectionCount(): number {
    return this.ports.size;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async handleIncoming(port: MessagePort, raw: unknown): Promise<void> {
    const msg = normalize(raw);
    if (!msg?.action) return;

    switch (msg.action) {
      case Actions.Ping: {
        const pong: Message<{ password?: string }> = {
          action: Actions.Pong,
          payload: this.opts.pongPassword ? { password: this.opts.pongPassword } : undefined,
          timestamp: Date.now(),
          requestId: msg.requestId,
        };
        this.send(port, pong);
        return;
      }

      case Actions.OutboxStreamBatch: {
        // Window sent an outbox batch — unlikely in this architecture but handle gracefully.
        // More commonly the worker pushes batches TO windows via broadcast().
        const p = msg.payload as OutboxStreamBatchPayload;
        const ack: Message<OutboxStreamAckPayload> = {
          action: Actions.OutboxStreamAck,
          timestamp: Date.now(),
          requestId: msg.requestId,
          payload: { ok: true, okIndices: (p?.events ?? []).map((_e, i) => i) },
        };
        this.send(port, ack);
        return;
      }

      case Actions.QueryRequest: {
        if (!this.opts.queryHandler) {
          const err: Message<QueryResponsePayload> = {
            action: Actions.QueryResponse,
            requestId: msg.requestId,
            timestamp: Date.now(),
            payload: { ok: false, err: 'No queryHandler configured on SharedWorkerServer' },
          };
          this.send(port, err);
          return;
        }

        const { name, dto } = (msg.payload as QueryRequestPayload) ?? {};
        if (typeof name !== 'string') return;

        try {
          const data = await this.opts.queryHandler(name, dto);
          const reply: Message<QueryResponsePayload> = {
            action: Actions.QueryResponse,
            requestId: msg.requestId,
            timestamp: Date.now(),
            payload: { ok: true, data },
          };
          this.send(port, reply);
        } catch (e: any) {
          const reply: Message<QueryResponsePayload> = {
            action: Actions.QueryResponse,
            requestId: msg.requestId,
            timestamp: Date.now(),
            payload: { ok: false, err: String(e?.message ?? e) },
          };
          this.send(port, reply);
        }
        return;
      }

      default:
        return;
    }
  }

  private send(port: MessagePort, msg: Message): void {
    try {
      port.postMessage(JSON.stringify(msg));
    } catch {
      this.ports.delete(port);
    }
  }
}

// -----------------------------------------------------------------------------
// Helper
// -----------------------------------------------------------------------------

function normalize(raw: unknown): Message | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Message;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw as Message;
  return null;
}
