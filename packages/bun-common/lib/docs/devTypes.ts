/**
 * {@link devTypes} (typed-client plan `docs/plans/typed-client/` §3.3, §8.3,
 * PR-M2): the server half of the live type sync. In development it serves a
 * running app's documents — `generateOpenApi`'s and `generateAsyncApi`'s,
 * with their {@link typesHash} — to a watcher (`bun-client watch`, PR-C3)
 * that regenerates the client's types when they change, and announces each
 * change over a WebSocket channel.
 *
 * ```ts
 * import { devTypes } from "@kingsleyweb/bun-common/lib/docs";
 *
 * app.use(devTypes(app, {
 *   enabled: process.env.NODE_ENV !== "production",
 *   openapi: { title: "API", version: "1" },
 * }));
 * ```
 *
 * **The protocol** (plan §3.3), under `path` (default `/__bun/types`):
 *
 * - `GET <path>`: `200` with `{ hash, openapi, asyncapi }`, `ETag: "<hash>"`,
 *   `Cache-Control: no-store`; `304` on a matching `If-None-Match`.
 *   `GET <path>/openapi.json` and `GET <path>/asyncapi.json` serve each
 *   document alone, with the same `ETag`, for third-party tools.
 * - **Named documents** (`documents`, issue #768): each also at
 *   `GET <path>/<name>`, `<path>/<name>/openapi.json` and
 *   `<path>/<name>/asyncapi.json`, the same way, with its own hash — one
 *   typed client per frontend, each from a filtered document, kept live by
 *   one server and one watcher.
 * - `<path>/ws`: a WebSocket channel (a `defineChannel`, subprotocol
 *   `bun-types.v1`, which the client must offer). The server sends
 *   `hello { version, hash, documents? }` on connect and in answer to a
 *   `ping`, and `changed { hash, at, documents? }` whenever a hash moves:
 *   `hash` is the unnamed document's, `documents` each named one's, by name
 *   (absent with none). It carries hashes, never documents.
 * - A token file (default `node_modules/.cache/bun-types/<port>.json`, mode
 *   `0600`) holds the URL, the bearer token and the named documents' names,
 *   so a watcher on the same machine finds a running server.
 *
 * **Fail closed.** It does nothing unless `enabled` is exactly `true`;
 * `NODE_ENV=production` with `enabled: true` is a {@link ConfigError}; and
 * every request must come from a loopback peer (unless `allowRemote`) and
 * carry the bearer token, or it is refused as if the route did not exist —
 * the app's own not-found answer, with nothing in it that names this
 * endpoint. `NODE_ENV` is read again on every request, so a process that
 * switches to production refuses from then on.
 *
 * **Lazy.** Nothing is generated until an authorized `GET` or a connected
 * watcher asks; the documents are then cached until the app's routes change
 * (`BunRouter.routesVersion`, `BunWebSocket.routesVersion`), which is polled
 * every 100 ms only while a watcher is connected.
 *
 * **`bun --hot`.** The token, the connected watchers and the last announced
 * hash live on `globalThis`, keyed by `path`, so a re-evaluation keeps them:
 * the new `devTypes()` takes over, rebuilds and announces the new hash on
 * the open sockets as soon as its app listens (or `listening()` is called),
 * without waiting for the poll. One dev sync per `path` per process, therefore — a second
 * `devTypes()` on the same path takes over the first's watchers. (The server
 * survives the re-evaluation: under `--hot`, a `BunHttpAdapter` that calls
 * `listen()` again, like a bare `Bun.serve()` on the same address, reloads
 * the running server, which Bun finds by its address-derived `id`.)
 */
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import type { BunRequest } from "../BunRequest";
import type { BunResponse } from "../BunResponse";
import type { NextFunction, RouterHandler } from "../types/general";
import type { AsyncApiOptions } from "./asyncapi";
import type { OpenApiOptions } from "./openapi";
import type { AsyncApiDocument, OpenApiDocument } from "./types";
import { BunRouter } from "../BunRouter";
import { toStandardSchema } from "../BunValidate";
import { defineChannel } from "../channel";
import { attachContract, getContract } from "../contract/transport";
import { ConfigError } from "../errors";
import { generateAsyncApi } from "./asyncapi";
import { typesHash } from "./hash";
import { generateOpenApi } from "./openapi";
import { attachRouteDoc } from "./routeDoc";

/* ------------------------------------------------------------------ *
 * Options and the returned router
 * ------------------------------------------------------------------ */

/** The OpenAPI source of a dev document: `generateOpenApi(app, options)`'s options, or a function returning the document. */
export type DevTypesOpenApiSource =
  | (Omit<OpenApiOptions, "title" | "version"> &
      Partial<Pick<OpenApiOptions, "title" | "version">>)
  | (() => OpenApiDocument | Promise<OpenApiDocument>);

/** The AsyncAPI source of a dev document: `generateAsyncApi(app, options)`'s options, or a function returning the document. */
export type DevTypesAsyncApiSource =
  | (Omit<AsyncApiOptions, "title" | "version"> &
      Partial<Pick<AsyncApiOptions, "title" | "version">>)
  | (() => AsyncApiDocument | Promise<AsyncApiDocument>);

/** One named document of {@link DevTypesOptions.documents}. */
export interface DevTypesDocumentOptions {
  /**
   * Its OpenAPI document, as {@link DevTypesOptions.openapi} takes it — most
   * often `{ filter }`, the routes one frontend calls. Default: the unnamed
   * document's source ({@link DevTypesOptions.openapi}).
   */
  openapi?: DevTypesOpenApiSource;
  /**
   * Its AsyncAPI document, as {@link DevTypesOptions.asyncapi} takes it.
   * Default: the unnamed document's source ({@link DevTypesOptions.asyncapi}),
   * so a filtered client still gets the app's channels unless this says
   * otherwise.
   */
  asyncapi?: DevTypesAsyncApiSource;
}

/** Options for {@link devTypes}. */
export interface DevTypesOptions {
  /**
   * Must be exactly `true`, or `devTypes()` registers nothing (there is no
   * implicit on). With `true` under `NODE_ENV=production` it throws a
   * {@link ConfigError}: write `enabled: process.env.NODE_ENV !== "production"`.
   */
  enabled: boolean;
  /**
   * Where the endpoint is served: the documents at `path`, each alone at
   * `path/openapi.json` and `path/asyncapi.json`, the channel at
   * `path/ws`. An absolute path with no parameters and no trailing slash.
   * Default: `"/__bun/types"`. Mount the returned router at the root
   * (`app.use(devTypes(app, …))`): the channel is registered on `app` at
   * this path, and the token file names it.
   */
  path?: string;
  /**
   * The bearer token every request must carry (`Authorization: Bearer
   * <token>`, or, on the channel, a `token.<token>` subprotocol offered
   * beside `bun-types.v1`, for a browser tool). At least 16 characters of
   * `A–Z a–z 0–9 . _ ~ -`. Default: a random one per process (32 random
   * bytes, base64url), kept across `bun --hot` re-evaluations and written to
   * the token file.
   */
  token?: string;
  /**
   * Accept peers that are not loopback (`127.0.0.0/8`, `::1`,
   * `::ffff:127.x.x.x`). Default: `false`, so only this machine is answered.
   * A request with no peer address — a socket-free `fetch()`, a request on a
   * unix socket — is in-process or local by construction and counts as
   * loopback. The token is required either way.
   */
  allowRemote?: boolean;
  /**
   * The OpenAPI document's source: `generateOpenApi(app, options)`'s
   * options (`title` and `version` optional), or a function returning the
   * document (sync or async) — bun-nest's `DevTypesModule` passes
   * `() => generateOpenApi(adapter.instance, …).document`. Default:
   * `generateOpenApi(app, { title: "API", version: "dev" })`. Either way the
   * document is rebuilt only when the app's routes change.
   */
  openapi?: DevTypesOpenApiSource;
  /**
   * The AsyncAPI document's source: `generateAsyncApi(app, options)`'s
   * options (`title` and `version` optional), or a function returning the
   * document (bun-nest: `() => gatewayAsyncApi(app)`). Default:
   * `generateAsyncApi(app, { title: "API", version: "dev" })`.
   */
  asyncapi?: DevTypesAsyncApiSource;
  /**
   * Named documents served beside the unnamed one, each at `<path>/<name>`
   * (and `<path>/<name>/openapi.json`, `<path>/<name>/asyncapi.json`) with a
   * hash of its own, which the change channel announces by name: one typed
   * client per frontend, each generated from a filtered document (`bun-client
   * watch --document <name> --out <file>`, several in one watcher). A name is
   * letters, digits, `_` and `-`, starting with a letter or digit, and not
   * `ws`. Each is built with the others, only when the app's routes change.
   * Default: none.
   *
   * ```ts
   * devTypes(app, {
   *   enabled: true,
   *   documents: {
   *     customer: { openapi: { filter: (op) => !op.path.startsWith("/api/admin") } },
   *     backoffice: { openapi: { filter: (op) => op.path.startsWith("/api/admin") } },
   *   },
   * });
   * ```
   */
  documents?: Record<string, DevTypesDocumentOptions>;
  /**
   * Where the token file is written once the server listens, relative to
   * the working directory; `<port>` is replaced by the server's port. `false`
   * writes none (give the watcher the URL and token yourself). Default:
   * `"node_modules/.cache/bun-types/<port>.json"`. Written atomically (a
   * temporary file renamed over it) with mode `0600` in a directory created
   * `0700`; holds `{ url, ws, token, pid }`, and `documents` (the named
   * documents' names) when there are any. Removed by {@link
   * DevTypesRouter.close}, on the adapter's `close`, and at process exit,
   * and on `SIGTERM` and `SIGINT` (the process then still ends with the
   * signal's own exit code, unless the app has a listener of its own, which
   * decides). A process killed by any other signal (`SIGKILL`, `SIGHUP`)
   * leaves it behind, and the next server on that port replaces it (a watcher
   * tells a stale one by its `pid`).
   */
  tokenFile?: string | false;
}

/** The server a token file is written for (Bun's `Server` fits): its `port` and `hostname`. */
interface DevTypesServer {
  /** The port the server listens on; none (a unix socket): no token file. */
  readonly port?: number | undefined;
  /** The hostname it listens on; a wildcard (`0.0.0.0`, `::`) is written as `127.0.0.1`. */
  readonly hostname?: string | undefined;
}

/** What {@link devTypes} returns: a router to mount, plus its token and lifecycle. */
export interface DevTypesRouter extends BunRouter {
  /** The bearer token requests must carry; `undefined` when the sync is disabled. */
  readonly token: string | undefined;
  /** The token file written for the current server, absolute; `undefined` before one is written, after {@link close}, or when disabled. */
  readonly tokenFile: string | undefined;
  /**
   * Tells the sync the server it is served on, and writes the token file for
   * its port. Called for you when `app` is a `BunHttpAdapter` (on its
   * `listening` event, or at once when it already listens); call it yourself
   * after `Bun.serve()` for a bare router. A no-op when disabled.
   */
  listening: (server: {
    /** The port the server listens on; none (a unix socket): no token file. */
    readonly port?: number | undefined;
    /** The hostname it listens on; a wildcard (`0.0.0.0`, `::`) is written as `127.0.0.1`. */
    readonly hostname?: string | undefined;
  }) => void;
  /**
   * Removes the token file (when it still holds this sync's token), closes
   * the connected watchers' sockets (`1001`) and stops the route poll.
   * Called for you on a `BunHttpAdapter`'s `close`. The routes stay
   * registered, and a later {@link listening} writes the file again.
   */
  close: () => void;
}

/* ------------------------------------------------------------------ *
 * The channel's messages
 * ------------------------------------------------------------------ */

/** The protocol's version, in `hello` (bump with the subprotocol). */
const PROTOCOL_VERSION = 1;
/** The channel's subprotocol, which a client must offer. */
const SUBPROTOCOL = "bun-types.v1";
/** The prefix of a token offered as a subprotocol. */
const TOKEN_PROTOCOL_PREFIX = "token.";
/** The default endpoint path (plan §14 Q10). */
const DEFAULT_PATH = "/__bun/types";
/** The default token file (plan §14 Q10), relative to the working directory. */
const DEFAULT_TOKEN_FILE = "node_modules/.cache/bun-types/<port>.json";
/** How often the route set is polled while a watcher is connected. */
const POLL_MS = 100;
/** A token: what a subprotocol may carry, long enough to guess at no rate. */
const TOKEN_PATTERN = /^[\w.~-]{16,}$/;
/** A named document's name: a path segment with no dot, so it never meets `openapi.json`. */
const DOCUMENT_NAME_PATTERN = /^[a-z0-9][\w-]*$/i;
/** Names a document cannot take: the channel's segment. */
const RESERVED_DOCUMENT_NAMES = new Set(["ws"]);

/** `hello`: the protocol version and the current hash. */
interface HelloData {
  /** The protocol version ({@link PROTOCOL_VERSION}). */
  version: number;
  /** The unnamed document's current hash. */
  hash: string;
  /** Each named document's current hash, by name; absent when there are none. */
  documents?: Record<string, string>;
}

/** `changed`: the new hash and when it was seen (epoch milliseconds). */
interface ChangedData {
  /** The unnamed document's new hash. */
  hash: string;
  /** When the change was seen, in epoch milliseconds. */
  at: number;
  /** Each named document's hash now, by name; absent when there are none. */
  documents?: Record<string, string>;
}

/** Whether `value` is `{ [name]: string }`. */
function isHashMap(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((hash) => typeof hash === "string")
  );
}

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const Hello = toStandardSchema<HelloData>(
  (value) =>
    isRecord(value) &&
    typeof value.version === "number" &&
    typeof value.hash === "string" &&
    (value.documents === undefined || isHashMap(value.documents))
      ? {
          value: {
            version: value.version,
            hash: value.hash,
            ...(value.documents === undefined
              ? {}
              : { documents: value.documents }),
          },
        }
      : {
          issues: [
            {
              message:
                "hello is { version: number, hash: string, documents?: { [name]: string } }",
            },
          ],
        },
  { vendor: "bun-common" },
);

const Changed = toStandardSchema<ChangedData>(
  (value) =>
    isRecord(value) &&
    typeof value.hash === "string" &&
    typeof value.at === "number" &&
    (value.documents === undefined || isHashMap(value.documents))
      ? {
          value: {
            hash: value.hash,
            at: value.at,
            ...(value.documents === undefined
              ? {}
              : { documents: value.documents }),
          },
        }
      : {
          issues: [
            {
              message:
                "changed is { hash: string, at: number, documents?: { [name]: string } }",
            },
          ],
        },
  { vendor: "bun-common" },
);

/** The channel for `path`: declared like any channel, so it is typed and checked. */
function devTypesChannel(wsPath: string) {
  return defineChannel({
    path: wsPath,
    receives: { ping: null },
    sends: { hello: Hello, changed: Changed },
    replies: { ping: "hello" },
    subprotocol: SUBPROTOCOL,
    meta: {
      name: "bun-types",
      description:
        "The dev type sync's change channel: the documents' hash on connect and on every change.",
    },
  });
}

/** The channel's type, for the state below. */
type DevTypesChannel = ReturnType<typeof devTypesChannel>;

/* ------------------------------------------------------------------ *
 * The process-wide hub (survives `bun --hot`)
 * ------------------------------------------------------------------ */

/** One `path`'s state across re-evaluations. */
interface Hub {
  /** The generated token, reused by the next `devTypes()` on this path. */
  token: string | undefined;
  /** Every open watcher socket. */
  sockets: Set<ServerWebSocket<unknown>>;
  /** The sockets greeted with `hello`, which `changed` goes to. */
  greeted: WeakSet<ServerWebSocket<unknown>>;
  /** The hashes last announced (in a `hello` or a `changed`), as one key: the unnamed document's and each named one's. */
  announced: string | undefined;
  /** The `devTypes()` instance answering for the path now (the latest). */
  owner: Instance | undefined;
  /** The route poll, running while a watcher is connected. */
  timer: ReturnType<typeof setInterval> | undefined;
}

/** Everything `devTypes()` keeps on `globalThis`. */
interface Registry {
  /** One hub per `path`. */
  hubs: Map<string, Hub>;
  /** The token files written, absolute path → the token in it (removed at exit). */
  files: Map<string, string>;
  /** Whether the process `exit` hook is installed. */
  exitHook: boolean;
  /** The `SIGTERM`/`SIGINT` listeners installed while a token file is written, by signal. */
  signalHooks: Map<TermSignal, () => void>;
}

/** The instance-side operations the hub's timer and socket handlers call. */
interface Instance {
  /** Builds when stale, announces a moved hash to the greeted sockets, and returns the current build. */
  refresh: () => Promise<Built>;
  /** Sends `hello` to `ws` (after a refresh), echoing `id` — the `ping`'s, when it answers one. */
  greet: (ws: ServerWebSocket<unknown>, id?: string) => Promise<void>;
  /** The channel the instance sends on. */
  channel: DevTypesChannel | undefined;
  /** Logs a failure. */
  fail: (message: string, error: unknown) => void;
}

const REGISTRY_KEY = Symbol.for("@kingsleyweb/bun-common/devTypes");

/** The registry on `globalThis`, created on first use. */
function registry(): Registry {
  const holder = globalThis as { [REGISTRY_KEY]?: Registry };
  return (holder[REGISTRY_KEY] ??= {
    hubs: new Map(),
    files: new Map(),
    exitHook: false,
    signalHooks: new Map(),
  });
}

/** The hub for `path`, created on first use. */
function hubFor(path: string): Hub {
  const hubs = registry().hubs;
  let hub = hubs.get(path);
  if (hub === undefined) {
    hub = {
      token: undefined,
      sockets: new Set(),
      greeted: new WeakSet(),
      announced: undefined,
      owner: undefined,
      timer: undefined,
    };
    hubs.set(path, hub);
  }
  return hub;
}

/** Starts the route poll while a watcher is connected. */
function startPoll(hub: Hub): void {
  if (hub.timer !== undefined) return;
  hub.timer = setInterval(() => {
    const owner = hub.owner;
    if (owner === undefined) return;
    owner.refresh().catch((error: unknown) => {
      owner.fail("devTypes(): rebuilding the documents failed", error);
    });
  }, POLL_MS);
  // A dev server's watcher must never keep a finished process alive.
  hub.timer.unref();
}

/** Stops the route poll. */
function stopPoll(hub: Hub): void {
  if (hub.timer === undefined) return;
  clearInterval(hub.timer);
  hub.timer = undefined;
}

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

/** Whether `address` is a loopback address (IPv4 `127/8`, IPv6 `::1`, or IPv4-mapped loopback). */
function isLoopbackAddress(address: string): boolean {
  const lower = address.toLowerCase();
  return (
    lower === "::1" ||
    lower.startsWith("127.") ||
    lower.startsWith("::ffff:127.")
  );
}

/**
 * Whether the request's peer is loopback. No peer address (a socket-free
 * `fetch()`, a unix socket) counts: such a request is in-process or local.
 */
function isLoopbackPeer(req: BunRequest): boolean {
  const peer = req.socketAddress;
  return peer === null || isLoopbackAddress(peer.address);
}

/** SHA-256 of `value`, so the comparison below runs on equal lengths. */
function digest(value: string): Buffer {
  return new Bun.CryptoHasher("sha256").update(value).digest();
}

/** Whether `presented` is `token`, compared in constant time. */
function tokenMatches(presented: string | undefined, token: string): boolean {
  if (presented === undefined) return false;
  return timingSafeEqual(digest(presented), digest(token));
}

/** The bearer token of `Authorization: Bearer <t>` (the scheme case-insensitive). */
function bearerToken(req: BunRequest): string | undefined {
  const header = req.headersObj.get("authorization");
  if (typeof header !== "string") return undefined;
  const match = /^bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

/** The subprotocols the request offers, trimmed. */
function offeredProtocols(req: BunRequest): string[] {
  const header = req.headersObj.get("sec-websocket-protocol");
  if (typeof header !== "string") return [];
  return header
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one !== "");
}

/** Whether an `If-None-Match` header matches `etag` (a list, a weak tag or `*` included). */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header
    .split(",")
    .map((one) => one.trim().replace(/^W\//, ""))
    .some((one) => one === etag || one === "*");
}

/* ------------------------------------------------------------------ *
 * The token file
 * ------------------------------------------------------------------ */

/** The host a watcher should dial for `hostname` (a wildcard becomes loopback). */
function dialHost(hostname: string | undefined): string {
  if (
    hostname === undefined ||
    hostname === "" ||
    hostname === "0.0.0.0" ||
    hostname === "::" ||
    hostname === "[::]"
  ) {
    return "127.0.0.1";
  }
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
}

/** Removes `file` when it still holds `token` (a later server's file is left alone). */
function removeTokenFile(file: string, token: string): void {
  try {
    const held = JSON.parse(readFileSync(file, "utf8")) as { token?: unknown };
    if (held.token === token) unlinkSync(file);
  } catch {
    // Gone already, or not ours to read: nothing to remove.
  }
}

/** Installs the process `exit` hook that removes every token file still written. */
function installExitHook(): void {
  const reg = registry();
  if (reg.exitHook) return;
  reg.exitHook = true;
  process.on("exit", () => {
    for (const [file, token] of reg.files) removeTokenFile(file, token);
    reg.files.clear();
  });
}

/** The signals whose default action (exit) is kept after the token files are removed. */
type TermSignal = "SIGTERM" | "SIGINT";

const TERM_SIGNALS: readonly TermSignal[] = ["SIGTERM", "SIGINT"];

/**
 * Installs `SIGTERM` and `SIGINT` listeners that remove the token files (the
 * `exit` hook does not run when a signal kills the process). A listener
 * suppresses the signal's default exit, so when it is the only one left it
 * removes itself and re-raises the signal, which ends the process as it would
 * have ended (128 + the signal number). When the app has a listener of its own
 * this one does nothing: the app decides, and the `exit` hook removes the files
 * when it exits.
 */
function installSignalHooks(): void {
  const reg = registry();
  for (const signal of TERM_SIGNALS) {
    if (reg.signalHooks.has(signal)) continue;
    const hook = (): void => {
      if (process.listenerCount(signal) > 1) return;
      for (const [file, token] of reg.files) removeTokenFile(file, token);
      reg.files.clear();
      removeSignalHooks();
      process.kill(process.pid, signal);
    };
    reg.signalHooks.set(signal, hook);
    process.on(signal, hook);
  }
}

/** Removes the signal listeners {@link installSignalHooks} installed. */
function removeSignalHooks(): void {
  const reg = registry();
  for (const [signal, hook] of reg.signalHooks) process.off(signal, hook);
  reg.signalHooks.clear();
}

/** Writes `content` to `file` atomically (a temporary file renamed over it), mode `0600`. */
function writeAtomically(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Never created.
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * devTypes()
 * ------------------------------------------------------------------ */

/** One document's build: its hash and its three views. */
interface BuiltDocument {
  /** The document's hash. */
  hash: string;
  /** `{ hash, openapi, asyncapi }` as JSON. */
  body: string;
  /** The OpenAPI document as JSON. */
  openapiBody: string;
  /** The AsyncAPI document as JSON. */
  asyncapiBody: string;
}

/** One build of the documents: the unnamed one's fields, plus each named one. */
interface Built extends BuiltDocument {
  /** The route-set version the build was taken at. */
  version: string;
  /** Each named document's build, by name. */
  named: Map<string, BuiltDocument>;
  /** Each named document's hash, by name; `undefined` when there are none. */
  hashes: Record<string, string> | undefined;
  /** Every hash in one string: what the hub compares to decide a change was announced. */
  signature: string;
}

/** A random token: 32 bytes, base64url (43 characters). */
function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  );
}

/** Adds the members of a disabled sync to `router`. */
function disabled(router: BunRouter): DevTypesRouter {
  return Object.assign(router, {
    token: undefined,
    tokenFile: undefined,
    listening: (_server: DevTypesServer): void => {},
    close: (): void => {},
  });
}

/**
 * The dev type sync for `app`: a router serving `app`'s documents and their
 * hash, plus a change channel registered on `app` itself. Mount the router
 * at the root. See the module comment for the protocol and the security
 * model.
 *
 * Disabled (`enabled` not exactly `true`), it returns an empty router and
 * registers nothing. Enabled, the channel is served when `app` has a
 * `BunWebSocket` attached (a `BunHttpAdapter` always has); otherwise only
 * the HTTP endpoints are, and a warning says so.
 *
 * @param app The router whose routes are documented, and which serves the
 *   channel — normally the `BunHttpAdapter`. On a `BunHttpAdapter` the token
 *   file follows its `listening` and `close` events.
 * @param options See {@link DevTypesOptions}.
 * @throws ConfigError when enabled under `NODE_ENV=production`, or for a
 *   malformed `path` or `token`.
 */
export function devTypes(
  app: BunRouter,
  options: DevTypesOptions,
): DevTypesRouter {
  const router = new BunRouter();
  if (options?.enabled !== true) {
    return disabled(router);
  }
  if (process.env.NODE_ENV === "production") {
    throw new ConfigError(
      'devTypes(): refused under NODE_ENV=production — the dev type sync is for development only; pass enabled: process.env.NODE_ENV !== "production"',
    );
  }
  const path = options.path ?? DEFAULT_PATH;
  if (
    !path.startsWith("/") ||
    path.length < 2 ||
    path.endsWith("/") ||
    /[:*?(){}]/.test(path)
  ) {
    throw new ConfigError(
      "devTypes(): `path` must be an absolute path with no parameters and no trailing slash",
      { path },
    );
  }
  if (options.token !== undefined && !TOKEN_PATTERN.test(options.token)) {
    throw new ConfigError(
      "devTypes(): `token` must be at least 16 characters of A-Z a-z 0-9 . _ ~ -",
    );
  }
  const namedOptions = Object.entries(options.documents ?? {});
  for (const [name] of namedOptions) {
    if (
      !DOCUMENT_NAME_PATTERN.test(name) ||
      RESERVED_DOCUMENT_NAMES.has(name)
    ) {
      throw new ConfigError(
        "devTypes(): a `documents` name is letters, digits, `_` and `-`, starting with a letter or digit, and not `ws`",
        { name },
      );
    }
  }
  const wsPath = `${path}/ws`;
  const allowRemote = options.allowRemote === true;
  const tokenFileTemplate =
    options.tokenFile === undefined ? DEFAULT_TOKEN_FILE : options.tokenFile;
  const hub = hubFor(path);
  const token = options.token ?? (hub.token ??= randomToken());
  const logger = app.logger;

  /* The documents' sources. */
  const openApiSourceOf = (
    option: DevTypesOpenApiSource | undefined,
  ): (() => OpenApiDocument | Promise<OpenApiDocument>) =>
    typeof option === "function"
      ? option
      : () =>
          generateOpenApi(app, {
            title: "API",
            version: "dev",
            ...option,
          }).document;
  const asyncApiSourceOf = (
    option: DevTypesAsyncApiSource | undefined,
  ): (() => AsyncApiDocument | Promise<AsyncApiDocument>) =>
    typeof option === "function"
      ? option
      : () =>
          generateAsyncApi(app, {
            title: "API",
            version: "dev",
            ...option,
          }).document;
  const openApiSource = openApiSourceOf(options.openapi);
  const asyncApiSource = asyncApiSourceOf(options.asyncapi);
  /** The named documents' sources; an omitted one is the unnamed document's. */
  const namedSources = namedOptions.map(([name, document]) => ({
    name,
    openapi:
      document?.openapi === undefined
        ? openApiSource
        : openApiSourceOf(document.openapi),
    asyncapi:
      document?.asyncapi === undefined
        ? asyncApiSource
        : asyncApiSourceOf(document.asyncapi),
  }));
  const names = namedSources.map((source) => source.name);

  /** The route set's version now: `app`'s, its socket's, and the socket's router's when that is another. */
  const versionNow = (): string => {
    const socket = app.getBunWebsocket();
    const socketRouter = socket?.router;
    return [
      app.routesVersion,
      socket?.routesVersion ?? -1,
      socketRouter !== undefined && socketRouter !== app
        ? socketRouter.routesVersion
        : -1,
    ].join(":");
  };

  let built: Built | undefined;
  let building: { version: string; promise: Promise<Built> } | undefined;

  /** The current build, built when the route set moved since the last one. */
  const current = (): Promise<Built> => {
    const version = versionNow();
    if (built !== undefined && built.version === version) {
      return Promise.resolve(built);
    }
    if (building !== undefined && building.version === version) {
      return building.promise;
    }
    const buildOne = async (
      openApi: () => OpenApiDocument | Promise<OpenApiDocument>,
      asyncApi: () => AsyncApiDocument | Promise<AsyncApiDocument>,
    ): Promise<BuiltDocument> => {
      const openapi = await openApi();
      const asyncapi = await asyncApi();
      const hash = typesHash({ openapi, asyncapi });
      return {
        hash,
        body: JSON.stringify({ hash, openapi, asyncapi }),
        openapiBody: JSON.stringify(openapi),
        asyncapiBody: JSON.stringify(asyncapi),
      };
    };
    const promise = (async (): Promise<Built> => {
      const unnamed = await buildOne(openApiSource, asyncApiSource);
      const named = new Map<string, BuiltDocument>();
      for (const source of namedSources) {
        named.set(source.name, await buildOne(source.openapi, source.asyncapi));
      }
      const hashes =
        named.size === 0
          ? undefined
          : Object.fromEntries(
              [...named].map(([name, document]) => [name, document.hash]),
            );
      return {
        ...unnamed,
        version,
        named,
        hashes,
        signature:
          hashes === undefined
            ? unnamed.hash
            : `${unnamed.hash} ${JSON.stringify(hashes)}`,
      };
    })();
    building = { version, promise };
    return promise.then(
      (result) => {
        if (building?.promise === promise) building = undefined;
        built = result;
        return result;
      },
      (error: unknown) => {
        if (building?.promise === promise) building = undefined;
        throw error;
      },
    );
  };

  const instance: Instance = {
    channel: undefined,
    async refresh() {
      const result = await current();
      if (hub.owner !== instance) return result;
      if (hub.announced !== undefined && hub.announced !== result.signature) {
        const channel = instance.channel;
        if (channel !== undefined) {
          const at = Date.now();
          for (const ws of hub.sockets) {
            if (!hub.greeted.has(ws)) continue;
            try {
              void channel.send(ws, "changed", {
                hash: result.hash,
                at,
                ...(result.hashes === undefined
                  ? {}
                  : { documents: result.hashes }),
              });
            } catch (error) {
              instance.fail("devTypes(): announcing a change failed", error);
            }
          }
        }
      }
      hub.announced = result.signature;
      return result;
    },
    async greet(ws, id) {
      const result = await instance.refresh();
      if (!hub.sockets.has(ws)) return;
      void instance.channel?.send(
        ws,
        "hello",
        {
          version: PROTOCOL_VERSION,
          hash: result.hash,
          ...(result.hashes === undefined ? {} : { documents: result.hashes }),
        },
        id === undefined ? undefined : { id },
      );
      hub.greeted.add(ws);
    },
    fail(message, error) {
      logger.error(message, { error });
    },
  };
  // The latest devTypes() on a path answers for it: what a `bun --hot`
  // re-evaluation needs. Its first build is compared with the hash the
  // previous instance announced, so the open watchers hear of the change:
  // when the re-evaluated app listens (`listening()` below), or at the next
  // poll for one that never does.
  hub.owner = instance;
  if (hub.sockets.size > 0) startPoll(hub);

  /** Whether the request passes every check; `viaProtocol`: a `token.<t>` subprotocol counts too. */
  const authorized = (req: BunRequest, viaProtocol: boolean): boolean => {
    if (process.env.NODE_ENV === "production") return false;
    if (!allowRemote && !isLoopbackPeer(req)) return false;
    let presented = bearerToken(req);
    if (presented === undefined && viaProtocol) {
      const offered = offeredProtocols(req).find((one) =>
        one.startsWith(TOKEN_PROTOCOL_PREFIX),
      );
      presented = offered?.slice(TOKEN_PROTOCOL_PREFIX.length);
    }
    return tokenMatches(presented, token);
  };

  /** The HTTP routes' guard: refused requests go on as if nothing matched. */
  const guard: RouterHandler = (
    req: BunRequest,
    _res: BunResponse,
    next: NextFunction,
  ) => {
    if (authorized(req, false)) {
      next();
      return;
    }
    next("router");
  };

  /**
   * Serves one view of one document of the build, with that document's hash
   * as its `ETag`. `name` picks a named document; none, the unnamed one.
   */
  const serve =
    (pick: (build: BuiltDocument) => string, name?: string): RouterHandler =>
    async (req: BunRequest, res: BunResponse) => {
      let build: Built;
      try {
        build = await instance.refresh();
      } catch (error) {
        instance.fail("devTypes(): building the documents failed", error);
        res.status(500);
        res.json({
          error: "Building the documents failed; see the server log",
        });
        return;
      }
      const result: BuiltDocument =
        name === undefined ? build : (build.named.get(name) ?? build);
      const etag = `"${result.hash}"`;
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "no-store");
      const ifNoneMatch = req.headersObj.get("if-none-match");
      if (
        etagMatches(
          typeof ifNoneMatch === "string" ? ifNoneMatch : undefined,
          etag,
        )
      ) {
        res.status(304);
        await res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.status(200);
      res.send(pick(result));
    };

  router
    .get(
      path,
      guard,
      serve((b) => b.body),
    )
    .describe({ hidden: true });
  router
    .get(
      `${path}/openapi.json`,
      guard,
      serve((b) => b.openapiBody),
    )
    .describe({ hidden: true });
  router
    .get(
      `${path}/asyncapi.json`,
      guard,
      serve((b) => b.asyncapiBody),
    )
    .describe({ hidden: true });
  for (const name of names) {
    router
      .get(
        `${path}/${name}`,
        guard,
        serve((b) => b.body, name),
      )
      .describe({ hidden: true });
    router
      .get(
        `${path}/${name}/openapi.json`,
        guard,
        serve((b) => b.openapiBody, name),
      )
      .describe({ hidden: true });
    router
      .get(
        `${path}/${name}/asyncapi.json`,
        guard,
        serve((b) => b.asyncapiBody, name),
      )
      .describe({ hidden: true });
  }

  /* The channel, on `app` itself (a socket route is the socket's router's). */
  if (app.getBunWebsocket() === undefined) {
    logger.warn(
      "devTypes(): the router has no BunWebSocket attached, so the change channel is not served (the HTTP endpoints are)",
      { path: wsPath },
    );
  } else {
    const channel = devTypesChannel(wsPath);
    instance.channel = channel;
    /** The channel's guard: every HTTP check, plus the subprotocol offered. A refusal leaves the app. */
    const channelGuard: RouterHandler = (
      req: BunRequest,
      _res: BunResponse,
      next: NextFunction,
    ) => {
      if (
        authorized(req, true) &&
        offeredProtocols(req).includes(SUBPROTOCOL)
      ) {
        next();
        return;
      }
      // Out of the app's router, past the upgrade layer: the app's
      // not-found answer, as for a path nothing serves.
      next("router");
    };
    const inner = channel.handler({
      ping(ws, _data, frame) {
        // Answered later (after a refresh), so the reply carries the ping's
        // id itself rather than being the handler's return.
        const owner = hub.owner ?? instance;
        owner.greet(ws, frame.id).catch((error: unknown) => {
          owner.fail("devTypes(): answering a ping failed", error);
        });
      },
    });
    const handler: WebSocketHandler<never> = {
      ...inner,
      open(ws) {
        void inner.open?.(ws);
        hub.sockets.add(ws);
        startPoll(hub);
        const owner = hub.owner ?? instance;
        owner.greet(ws).catch((error: unknown) => {
          owner.fail("devTypes(): greeting a watcher failed", error);
          ws.close(1011, "build failed");
        });
      },
      close(ws, code, reason) {
        void inner.close?.(ws, code, reason);
        hub.sockets.delete(ws);
        if (hub.sockets.size === 0) stopPoll(hub);
      },
    };
    const contract = getContract(inner);
    if (contract !== undefined) attachContract(handler, contract);
    app.ws(wsPath, channelGuard, channel.checks(), handler, channel.options());
    // Hidden from the documents like the HTTP routes: the chain route's
    // terminal callback carries the doc (`describe()` cannot reach a ws()).
    const chain = (
      app.routes() as unknown as { callbacks: readonly unknown[] }[]
    ).find((route) => route.callbacks.includes(channelGuard));
    const terminal = chain?.callbacks.at(-1);
    if (typeof terminal === "function") {
      attachRouteDoc(terminal, { hidden: true });
    }
  }

  /* The token file. */
  let writtenFile: string | undefined;

  const removeWritten = (): void => {
    if (writtenFile === undefined) return;
    removeTokenFile(writtenFile, token);
    const reg = registry();
    reg.files.delete(writtenFile);
    writtenFile = undefined;
    if (reg.files.size === 0) removeSignalHooks();
  };

  const listening = (server: DevTypesServer): void => {
    // A `bun --hot` takeover: the re-evaluated app is complete once it
    // listens (its routes are registered before), so the open watchers hear
    // of a moved hash now rather than at the next poll, up to `POLL_MS`
    // later. `refresh()` announces only a hash that differs.
    if (hub.owner === instance && hub.sockets.size > 0) {
      instance.refresh().catch((error: unknown) => {
        instance.fail("devTypes(): rebuilding the documents failed", error);
      });
    }
    if (tokenFileTemplate === false) return;
    const port = server.port;
    if (port === undefined || !Number.isInteger(port) || port <= 0) return;
    const file = resolve(
      process.cwd(),
      tokenFileTemplate.replaceAll("<port>", String(port)),
    );
    const origin = `${dialHost(server.hostname)}:${port}`;
    const content = `${JSON.stringify(
      {
        url: `http://${origin}${path}`,
        ws: `ws://${origin}${wsPath}`,
        token,
        pid: process.pid,
        ...(names.length === 0 ? {} : { documents: names }),
      },
      null,
      2,
    )}\n`;
    if (writtenFile !== undefined && writtenFile !== file) removeWritten();
    try {
      writeAtomically(file, content);
    } catch (error) {
      instance.fail("devTypes(): writing the token file failed", error);
      return;
    }
    writtenFile = file;
    registry().files.set(file, token);
    installExitHook();
    installSignalHooks();
  };

  const close = (): void => {
    removeWritten();
    if (hub.owner === instance) {
      stopPoll(hub);
      for (const ws of hub.sockets) ws.close(1001, "server closing");
      hub.sockets.clear();
    }
  };

  // Accessors, not copies: `tokenFile` follows the server.
  const result = Object.defineProperties(router, {
    token: { get: (): string => token, enumerable: true },
    tokenFile: { get: (): string | undefined => writtenFile, enumerable: true },
    listening: { value: listening },
    close: { value: close },
  }) as DevTypesRouter;

  /* A BunHttpAdapter: follow its server. */
  const adapter = app as {
    eventEmitter?: {
      on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
    };
    getBunServer?: () => DevTypesServer | undefined;
  };
  const emitter = adapter.eventEmitter;
  if (typeof emitter?.on === "function") {
    emitter.on("listening", (server) => {
      listening(server as DevTypesServer);
    });
    emitter.on("close", () => {
      close();
    });
  }
  if (typeof adapter.getBunServer === "function") {
    const server = adapter.getBunServer();
    if (server !== undefined) listening(server);
  }
  return result;
}
