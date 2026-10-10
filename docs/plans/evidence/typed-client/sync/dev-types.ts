/**
 * The server half of the live type sync, as a spike: a dev-only endpoint that
 * serves the route model (ETag = model hash, 304 on match) and a WebSocket
 * channel that announces the hash on connect and whenever it changes.
 *
 * Fails closed: it refuses to start unless explicitly enabled, refuses
 * outright under NODE_ENV=production, demands a bearer token, and answers
 * only loopback peers.
 */
import type { Server, ServerWebSocket } from "bun";
import type { RouteModel } from "../codegen/describe";

/** Options for {@link devTypes}. */
export interface DevTypesOptions {
  /** Must be `true`; there is no implicit on. */
  enabled: boolean;
  /** Mount path. Default "/__bun/types". */
  path?: string;
  /** Shared secret. Default: random per process, printed and written to `tokenFile`. */
  token?: string;
}

interface Hub {
  model: RouteModel | undefined;
  sockets: Set<ServerWebSocket<unknown>>;
}
const g = globalThis as unknown as { __devTypesHub?: Hub };
const hub: Hub = (g.__devTypesHub ??= { model: undefined, sockets: new Set() });

const isLoopback = (ip: string | undefined) => !!ip && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1");

/**
 * Publishes `model`. Called on every (re)evaluation of the app: under `bun --hot`
 * the hub survives in `globalThis`, so a changed hash is broadcast to the
 * connected watchers at once.
 */
export function publishModel(model: RouteModel): { changed: boolean } {
  const changed = hub.model?.hash !== model.hash;
  hub.model = model;
  if (changed) for (const ws of hub.sockets) ws.send(JSON.stringify({ type: "model", hash: model.hash, at: Date.now() }));
  return { changed };
}

export function devTypes(options: DevTypesOptions) {
  if (process.env.NODE_ENV === "production") throw new Error("devTypes: refused under NODE_ENV=production");
  if (options.enabled !== true) throw new Error("devTypes: not enabled");
  const path = options.path ?? "/__bun/types";
  const token = options.token ?? crypto.randomUUID();
  const authorized = (req: Request, server: Server) => {
    const ip = server.requestIP(req)?.address;
    const auth = req.headers.get("authorization");
    return isLoopback(ip) && auth === `Bearer ${token}`;
  };
  return {
    token,
    path,
    /** Returns a Response for this module's paths, or undefined for anything else. */
    handle(req: Request, server: Server): Response | undefined {
      const url = new URL(req.url);
      if (url.pathname !== path && url.pathname !== `${path}/ws`) return undefined;
      if (!authorized(req, server)) return new Response("not found", { status: 404 }); // never confirm it exists
      if (url.pathname === `${path}/ws`) {
        return server.upgrade(req, { data: undefined }) ? (undefined as unknown as Response) : new Response("upgrade failed", { status: 400 });
      }
      const model = hub.model;
      if (!model) return new Response("no model yet", { status: 503 });
      const etag = `"${model.hash}"`;
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
      return new Response(JSON.stringify(model), { headers: { "content-type": "application/json", etag, "cache-control": "no-store" } });
    },
    websocket: {
      open(ws: ServerWebSocket<unknown>) {
        hub.sockets.add(ws);
        if (hub.model) ws.send(JSON.stringify({ type: "model", hash: hub.model.hash, at: Date.now() }));
      },
      close(ws: ServerWebSocket<unknown>) {
        hub.sockets.delete(ws);
      },
      message() {},
    },
  };
}
