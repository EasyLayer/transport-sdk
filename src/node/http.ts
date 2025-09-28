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
 * - Does not start its own server. Instead, provides:
 *   * `nodeHttpHandler` — a Node http/https request listener.
 *   * `expressRouter()` — an Express Router with exact paths from options.
 * - Responds to pings with Pong (optionally including password).
 * - Accepts Outbox batches, fans them out to subscribers by `eventType`,
 *   then replies synchronously with ACK (`{ ok: true, okIndices }`).
 * - Sends queries to `${baseUrl}/query` as `{ name, data }` and expects
 *   `{ ok, data?, err? }` like your HttpTransportService.
 *
 * Notes:
 * - Token check (if configured): `x-transport-token`.
 * - ACK is synchronous in HTTP (returned as the response body).
 * - No timers/sockets are owned, so `close()` is a no-op.
 */
export class HttpClient {
  private readonly webhook: URL;
  private readonly pingPath?: string;
  private readonly token?: string;
  private readonly pongPassword?: string;
  private readonly maxBytes: number;

  private readonly queryBase: string;

  private subs = new Map<string, Set<SubscribeHandler>>();

  constructor(inbound: HttpInboundOptions, query: HttpQueryOptions) {
    if (!query?.baseUrl) throw new Error('[client-http] query.baseUrl is required');
    if (!inbound?.webhookUrl) throw new Error('[client-http] inbound.webhookUrl is required');

    this.webhook = new URL(inbound.webhookUrl);
    this.token = inbound.token;
    this.pongPassword = inbound.pongPassword;
    this.maxBytes = inbound.maxWireBytes ?? 1024 * 1024;

    // pingPath: either provided via pingUrl or default to '/ping'
    this.pingPath = (inbound.pingUrl ? new URL(inbound.pingUrl).pathname : '/ping').replace(/\/+$/, '') || '/ping';

    this.queryBase = query.baseUrl.replace(/\/+$/, '');

    // prevent accidental overlap with webhook path
    const hookPath = (this.webhook.pathname || '/events').replace(/\/+$/, '') || '/events';
    if (this.pingPath === hookPath) {
      throw new Error('[client-http] pingPath must differ from webhook path');
    }
  }

  // ---- subscriptions ----
  subscribe<T = any>(constructorName: string, handler: SubscribeHandler<T>): () => void {
    const set = this.subs.get(constructorName) ?? new Set();
    set.add(handler as any);
    this.subs.set(constructorName, set);
    return () => set.delete(handler as any);
  }
  getSubscriptionCount(constructorName: string): number {
    return this.subs.get(constructorName)?.size ?? 0;
  }
  private async dispatchBatch(batch: OutboxStreamBatchPayload) {
    const events = batch.events ?? [];
    for (const wire of events) {
      const name = wire.eventType;
      const set = this.subs.get(name);
      if (!set?.size) continue;
      const evt = createDomainEventFromWire(wire);
      for (const h of set) await h(evt);
    }
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
  // Passive inbox with two POST routes only:
  //   • POST {hookPath} – strictly accepts OutboxStreamBatch and replies with ACK.
  //   • POST {pingPath} – always returns Pong (optionally with { password }).
  //
  // Notes:
  // - No GET handlers; any non-POST or unknown path → 404.
  // - Token guard (x-transport-token) applies to both routes when configured.
  // - 400 for invalid JSON/payload; 422 for well-formed envelope with wrong action.
  nodeHttpHandler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Optional shared-secret guard
      if (this.token) {
        const got = String(req.headers['x-transport-token'] ?? '');
        if (got !== this.token) return this.replyText(res, 401, 'unauthorized');
      }

      // Normalize paths
      const pathname = (req.url?.split('?')[0] || '/').replace(/\/+$/, '');
      const hookPath = (this.webhook.pathname || '/').replace(/\/+$/, '') || '/';
      const pingPath = this.pingPath ?? '/ping';

      // 1) POST {pingPath} → Pong
      if (req.method === 'POST' && pathname === pingPath) {
        const pong: Message = {
          action: Actions.Pong,
          payload: this.pongPassword ? { password: this.pongPassword } : undefined,
          timestamp: Date.now(),
        };
        return this.replyJson(res, 200, pong);
      }

      // 2) POST {hookPath} → strictly OutboxStreamBatch
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

        await this.dispatchBatch(p);

        const ack: Message<OutboxStreamAckPayload> = {
          action: Actions.OutboxStreamAck,
          timestamp: Date.now(),
          payload: { ok: true, okIndices: p.events.map((_e, i) => i) },
        };
        return this.replyJson(res, 200, ack);
      }

      // 3) Everything else → 404
      return this.replyText(res, 404, 'not found');
    } catch (e: any) {
      return this.replyText(res, 500, String(e?.message ?? e ?? 'internal error'));
    }
  };

  // --- Express Router factory --------------------------------------------------
  // Exposes the same POST-only inbox:
  //   • POST {hookPath} – strictly OutboxStreamBatch → ACK
  //   • POST {pingPath} – always returns Pong
  //
  // Notes:
  // - Token guard attached to both routes if configured.
  expressRouter() {
    const r = express.Router();

    const hookPath = (this.webhook.pathname || '/').replace(/\/+$/, '') || '/';
    const pingPath = this.pingPath ?? '/ping';

    // Token guard for both inbox routes (if configured)
    if (this.token) {
      r.use([hookPath, pingPath], (req, res, next) => {
        const got = String(req.header('x-transport-token') ?? '');
        if (got !== this.token) return res.status(401).send('unauthorized');
        next();
      });
    }

    // POST {pingPath} → Pong
    r.post(pingPath, (_req, res) => {
      const pong: Message<{ password?: string }> = {
        action: Actions.Pong,
        payload: this.pongPassword ? { password: this.pongPassword } : undefined,
        timestamp: Date.now(),
      };
      res.status(200).json(pong);
    });

    // POST {hookPath} → strictly OutboxStreamBatch
    r.post(hookPath, express.json({ limit: '2mb' }), async (req, res) => {
      const msg = req.body as Message;

      if (!msg || typeof msg.action !== 'string') return res.status(422).send('invalid message');
      if (msg.action !== Actions.OutboxStreamBatch) return res.status(422).send('invalid action');

      const p = msg.payload as OutboxStreamBatchPayload;
      if (!p || !Array.isArray(p.events)) return res.status(400).send('invalid payload');

      await this.dispatchBatch(p);

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
}

async function safeReadText(res: Response) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
function readBodyBounded(
  req: IncomingMessage,
  limit: number
): Promise<{ ok: true; body: string } | { ok: false; errCode: number; errText: string }> {
  return new Promise((resolve) => {
    let size = 0;
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
