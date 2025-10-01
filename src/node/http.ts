import { URL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import type {
  Message,
  OutboxStreamAckPayload,
  OutboxStreamBatchPayload,
  QueryRequestPayload,
  QueryResponsePayload,
} from '../core';
import { Actions, createDomainEventFromWire, utf8Len, TRANSPORT_OVERHEAD_WIRE } from '../core';

export type HttpInboundOptions = {
  /** Full URL where the server will POST batches (defines exact path to mount). */
  webhookUrl: string;
  /** Optional separate URL for ping. If omitted, ping is served on webhook path as well. */
  pingUrl?: string;
  /** Optional token to validate inbound webhook/ping via "x-transport-token". */
  token?: string;
  /** If set, include { password } in Pong payload so the server accepts it. */
  pongPassword?: string;
  /** Maximum allowed wire size in bytes. Default: 1 MiB. */
  maxWireBytes?: number;
  /** Processing timeout for a batch before replying. Default: 3000 ms. */
  processTimeoutMs?: number;
};

export type HttpQueryOptions = {
  /** Application base URL for queries; will POST to `${baseUrl}/query`. */
  baseUrl: string;
};

export type SubscribeHandler<T = any> = (evt: T) => unknown | Promise<unknown>;

/**
 * HttpClient
 * -----------------------------------------------------------------------------
 * Role:
 * - Provides `nodeHttpHandler` and `expressRouter()` for inbound HTTP.
 * - Responds to pings with Pong (optionally including password).
 * - Accepts Outbox batches and processes them with type-level sequencing:
 *   * Exactly one subscriber per event type (duplicate subscription → error).
 *   * Events of the same type are processed **sequentially** in arrival order.
 *   * Different types are processed **in parallel**.
 *   * Types without a subscriber are ignored (no-op) and do not block ACK.
 * - Replies with ACK only after all relevant handlers finish within `processTimeoutMs`.
 */
export class HttpClient {
  private readonly webhook: URL;
  private readonly pingPath?: string;
  private readonly token?: string;
  private readonly pongPassword?: string;
  private readonly maxBytes: number;
  private readonly processTimeoutMs: number;
  private readonly queryBase: string;

  // One handler per event type
  private subs = new Map<string, SubscribeHandler>();

  constructor(inbound: HttpInboundOptions, query: HttpQueryOptions) {
    if (!query?.baseUrl) throw new Error('[client-http] query.baseUrl is required');
    if (!inbound?.webhookUrl) throw new Error('[client-http] inbound.webhookUrl is required');

    this.webhook = new URL(inbound.webhookUrl);
    this.token = inbound.token;
    this.pongPassword = inbound.pongPassword;
    this.maxBytes = inbound.maxWireBytes ?? 1024 * 1024;
    this.processTimeoutMs = Math.max(1, inbound.processTimeoutMs ?? 3000);

    this.pingPath = (inbound.pingUrl ? new URL(inbound.pingUrl).pathname : '/ping').replace(/\/+$/, '') || '/ping';
    this.queryBase = query.baseUrl.replace(/\/+$/, '');
  }

  /** Subscribe a handler to a specific DomainEvent constructor name. */
  subscribe<T = any>(eventType: string, handler: SubscribeHandler<T>) {
    if (this.subs.has(eventType)) {
      throw new Error(`[client-http] duplicate subscription for type "${eventType}"`);
    }
    this.subs.set(eventType, handler as SubscribeHandler);
    return () => {
      // Unsubscribe only if the same handler is still attached
      const current = this.subs.get(eventType);
      if (current === handler) this.subs.delete(eventType);
    };
  }

  // ---- query out ----
  async query<TRes = any>(req: QueryRequestPayload): Promise<TRes> {
    const body = JSON.stringify({ name: req.name, dto: req.dto });
    if (utf8Len(body) + TRANSPORT_OVERHEAD_WIRE > this.maxBytes) {
      throw new Error('[client-http] query payload too large');
    }

    const res = await fetch(this.queryBase + '/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`[client-http] ${res.status} ${text || ''}`.trim());
    }

    const p = (await res.json()) as QueryResponsePayload;
    if (!p || typeof p.ok !== 'boolean') throw new Error('[client-http] invalid query response');
    if (p.ok === false) throw new Error(String(p.err ?? 'query failed'));
    return p.data as TRes;
  }

  // --- Node HTTP/HTTPS request handler ----------------------------------------
  nodeHttpHandler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (this.token) {
        const got = String(req.headers['x-transport-token'] ?? '');
        if (got !== this.token) return this.replyText(res, 401, 'unauthorized');
      }

      const pathname = safePathname(req.url);
      const hookPath = (this.webhook.pathname || '/').replace(/\/+$/, '') || '/';
      const pingPath = this.pingPath ?? '/ping';

      if (req.method === 'POST' && pathname === pingPath) {
        const pong: Message = {
          action: Actions.Pong,
          timestamp: Date.now(),
          payload: this.pongPassword ? { password: this.pongPassword } : undefined,
        };
        return this.replyJson(res, 200, pong);
      }

      if (req.method === 'POST' && pathname === hookPath) {
        const body = await readBodyBounded(req, this.maxBytes - TRANSPORT_OVERHEAD_WIRE);
        if (!body.ok) return this.replyText(res, body.errCode!, body.errText!);

        let msg: Message;
        try {
          msg = JSON.parse(body.body || '{}');
        } catch {
          return this.replyText(res, 400, 'invalid json');
        }

        if (!msg || typeof msg.action !== 'string') return this.replyText(res, 422, 'invalid message');
        if (msg.action !== Actions.OutboxStreamBatch) return this.replyText(res, 422, 'invalid action');

        const p = msg.payload as OutboxStreamBatchPayload;
        if (!p || !Array.isArray(p.events)) return this.replyText(res, 400, 'invalid payload');

        await this.processBatchWithTimeout(p);

        const ack: Message<OutboxStreamAckPayload> = {
          action: Actions.OutboxStreamAck,
          timestamp: Date.now(),
          payload: { ok: true, okIndices: p.events.map((_e, i) => i) },
        };
        return this.replyJson(res, 200, ack);
      }

      return this.replyText(res, 404, 'not found');
    } catch (e: any) {
      return this.replyText(res, 500, String(e?.message ?? e ?? 'internal error'));
    }
  };

  // --- Express Router factory --------------------------------------------------
  expressRouter() {
    const r = express.Router();

    const hookPath = (this.webhook.pathname || '/').replace(/\/+$/, '') || '/';
    const pingPath = this.pingPath ?? '/ping';

    if (this.token) {
      r.use([hookPath, pingPath], (req, res, next) => {
        const got = String(req.header('x-transport-token') ?? '');
        if (got !== this.token) return res.status(401).send('unauthorized');
        next();
      });
    }

    r.post(pingPath, (_req, res) => {
      const pong: Message = {
        action: Actions.Pong,
        timestamp: Date.now(),
        payload: this.pongPassword ? { password: this.pongPassword } : undefined,
      };
      return res.status(200).json(pong);
    });

    r.post(hookPath, express.json({ limit: this.maxBytes }), async (req, res) => {
      const msg = req.body as Message;
      if (!msg || typeof msg.action !== 'string') return res.status(422).send('invalid message');
      if (msg.action !== Actions.OutboxStreamBatch) return res.status(422).send('invalid action');

      const p = msg.payload as OutboxStreamBatchPayload;
      if (!p || !Array.isArray(p.events)) return res.status(400).send('invalid payload');

      try {
        await this.processBatchWithTimeout(p);
      } catch (e: any) {
        return res.status(500).send(String(e?.message ?? e ?? 'internal error'));
      }

      const ack: Message<OutboxStreamAckPayload> = {
        action: Actions.OutboxStreamAck,
        timestamp: Date.now(),
        payload: { ok: true, okIndices: p.events.map((_e, i) => i) },
      };
      return res.status(200).json(ack);
    });

    return r;
  }

  async close(): Promise<void> {
    // No owned resources to release.
  }

  // ---- batch processing helpers ---------------------------------------------
  /**
   * Process a batch with a global timeout. If there are no relevant subscribers,
   * completes immediately. Any failure or timeout rejects.
   */
  private async processBatchWithTimeout(batch: OutboxStreamBatchPayload): Promise<void> {
    const work = this.dispatchBatch(batch);
    await this.withTimeout(work, this.processTimeoutMs);
  }

  /**
   * Route events by type with **sequential per-type processing** and
   * **parallel across types**. Types without a subscriber are ignored.
   */
  async dispatchBatch(batch: OutboxStreamBatchPayload) {
    const wires = batch.events ?? [];
    if (!wires.length) return;

    // 1) Build index lists per subscribed type (cheap routing, no object copies)
    const perTypeIdx = new Map<string, number[]>();
    for (let i = 0; i < wires.length; i++) {
      const w = wires[i]!;
      const handler = this.subs.get(w.eventType);
      if (!handler) continue; // no-op types do not block
      let arr = perTypeIdx.get(w.eventType);
      if (!arr) perTypeIdx.set(w.eventType, (arr = []));
      arr.push(i);
    }

    if (perTypeIdx.size === 0) return; // no relevant subscribers → immediate ACK

    // 2) For each type create ONE task that processes its events sequentially
    const tasks: Promise<void>[] = [];
    for (const [type, idxs] of perTypeIdx) {
      const handler = this.subs.get(type)!; // exists by construction
      tasks.push(
        (async () => {
          for (let k = 0; k < idxs.length; k++) {
            const wire = wires[idxs[k]!]!;
            const evt = createDomainEventFromWire(wire);
            await Promise.resolve().then(() => handler(evt)); // sequence preserved
          }
        })()
      );
    }

    // 3) Await all types in parallel; any failure rejects the batch
    await Promise.all(tasks);
  }

  // ---- helpers ----
  private replyJson(res: ServerResponse, code: number, obj: unknown) {
    const s = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
  }
  private replyText(res: ServerResponse, code: number, text: string) {
    res.writeHead(code, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('batch processing timeout')), ms);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }
}

// ---- tiny utils --------------------------------------------------------------
function safePathname(u?: string | null) {
  try {
    return new URL(u ?? '/', 'http://local').pathname;
  } catch {
    return '/';
  }
}
async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Read an entire request body with a hard cap on size. */
async function readBodyBounded(
  req: IncomingMessage,
  limit: number
): Promise<{ ok: true; body: string } | { ok: false; errCode: number; errText: string }> {
  let size = 0;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve({ ok: false, errCode: 413, errText: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve({ ok: true, body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ ok: false, errCode: 400, errText: 'bad request' }));
  });
}
