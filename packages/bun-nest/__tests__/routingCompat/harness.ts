/**
 * Boots one routing group on `@nestjs/platform-express`'s `ExpressAdapter`
 * and on `BunHttpAdapter`, sends a request to each, and reduces what comes
 * back to the fields the routing differential compares (plan §5.6): status,
 * parsed body, `content-type`, `allow`, `location`, `x-custom`, the handler
 * that ran (`x-h`) and the middleware trail (`x-trail`); per boot, the
 * warnings and errors Nest logged and the boot error, if any.
 *
 * Express is asked over its socket. Ours is asked through the socket-free
 * `adapter.fetch()` and over its own socket, and the two must agree.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type {
  INestApplication,
  LoggerService,
  NestApplicationOptions,
} from "@nestjs/common";
import { Buffer } from "node:buffer";
import { connect } from "node:net";
import {
  Logger,
  RequestMethod,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import { ApplicationConfig, NestFactory } from "@nestjs/core";
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter.js";
import { RouteInfoPathExtractor } from "@nestjs/core/middleware/route-info-path-extractor.js";
import { filterMiddleware } from "@nestjs/core/middleware/utils.js";
import { ExpressAdapter } from "@nestjs/platform-express";
import { BunHttpAdapter } from "../../lib/BunHttpAdapter";
import { expressReference } from "../expressCompat/reference";
import "reflect-metadata";

/**
 * Nest 12 or later, by the capability `BunHttpAdapter` itself reads
 * (`mapException`, added in 12.0.0 with prefix-scoped not-found).
 */
export const NEST_12 =
  typeof (AbstractHttpAdapter.prototype as { mapException?: unknown })
    .mapException === "function";

/**
 * Whether the installed platform-express strips the core's `<prefix>$`
 * exact-match marker into an exact route (12.1.3, nestjs/nest #17942). No
 * capability exposes it, so its `createMiddlewareFactory` is read, as
 * `expressCompat/probes.ts` does.
 */
export const EXPRESS_HONOURS_EXACT_MARKER = /endsWith\(["']\$["']\)/.test(
  ExpressAdapter.prototype.createMiddlewareFactory.toString(),
);

/**
 * Whether the core resolves `VERSION_NEUTRAL` in a middleware route
 * (`forRoutes({ path, version: VERSION_NEUTRAL })` under URI versioning) to
 * the unversioned path, as it does from 12.1.3 (nestjs/nest #17947). Before,
 * it builds `/vSymbol(VERSION_NEUTRAL)/ver`, which Express's path-to-regexp
 * rejects at boot. Asked of the core's own `RouteInfoPathExtractor`.
 */
export const CORE_RESOLVES_NEUTRAL_MIDDLEWARE = (() => {
  const config = new ApplicationConfig();
  config.enableVersioning({ type: VersioningType.URI });
  const paths = new RouteInfoPathExtractor(config).extractPathsFrom({
    path: "ver",
    method: RequestMethod.ALL,
    version: VERSION_NEUTRAL,
  });
  return !paths.some((path) => path.includes("Symbol("));
})();

/**
 * Whether the core asks the adapter how its router matches paths
 * (`HttpServer.getRouteMatchingOptions`, 12.2.0) to match the routes
 * excluded with `MiddlewareConsumer.exclude()`. Asked of the core's own
 * `filterMiddleware`, with an adapter that records the call; an earlier core
 * never makes it.
 */
export const CORE_READS_ROUTE_MATCHING_OPTIONS = (() => {
  let asked = false;
  const adapter = {
    getRouteMatchingOptions: () => {
      asked = true;
      return { caseSensitive: true, ignoreTrailingSlash: false };
    },
  };
  filterMiddleware([() => {}], [], adapter as never);
  return asked;
})();

/**
 * Whether the installed platform-express runs an exact middleware path (the
 * core's `<prefix>$`) on its trailing-slash variant too (12.2.0), leaving
 * the core to run the middleware once per request. 12.1.3 skipped a request
 * ending in `/` there (`req.path.endsWith('/')`); before 12.1.3 the marker
 * was not stripped at all. Read from its `createMiddlewareFactory`, as
 * {@link EXPRESS_HONOURS_EXACT_MARKER} is.
 */
export const EXPRESS_RUNS_EXACT_PATH_ON_SLASH =
  EXPRESS_HONOURS_EXACT_MARKER &&
  !/req\.path\.endsWith\(/.test(
    ExpressAdapter.prototype.createMiddlewareFactory.toString(),
  );

/** `BunHttpAdapter`'s constructor options. */
export type BunHttpAdapterOptions = ConstructorParameters<
  typeof BunHttpAdapter
>[1];

/** Which adapter an application runs on. */
export type Side = "express" | "bun";

/** One request: what to send, and the name it is reported (and KNOWN-keyed) by. */
export interface Probe {
  /** The probe's name, unique in its group; `KNOWN` keys are `<group>/<name>`. */
  name: string;
  /** The HTTP method; `GET` when unset. */
  method?: string;
  /** The request target, sent verbatim (a `//` path goes over a raw socket). */
  path: string;
  /** Request headers; `host` also becomes the authority of `adapter.fetch()`'s URL. */
  headers?: Record<string, string>;
}

/** An application to boot on both adapters, and the requests to send it. */
export interface Group {
  /** The group's name, unique; the first half of a `KNOWN` key. */
  name: string;
  /** The root module. */
  module: new () => object;
  /** Called after `create()`, before `listen()`. */
  configure?: (app: INestApplication) => void;
  /** `NestFactory.create` options, on both sides (Nest 12 route options). */
  options?: Record<string, unknown>;
  /** Extra `BunHttpAdapter` options, the Bun side only (bun-common's own ranking). */
  bunOptions?: BunHttpAdapterOptions;
  /** Skip the group unless this is true; a capability, never a version string. */
  when?: boolean;
  /** The requests. */
  probes: Probe[];
}

/** One logged line: `level [context] message`. */
type LogLine = string;

/** Records the warnings and errors an application logs while it boots. */
class CaptureLogger implements LoggerService {
  /** Every warning, error and fatal line, in order. */
  lines: LogLine[] = [];

  private push(level: string, message: unknown, rest: unknown[]) {
    const last = rest.at(-1);
    const context = typeof last === "string" ? ` [${last}]` : "";
    const text = message instanceof Error ? message.message : String(message);
    this.lines.push(`${level}${context} ${text}`);
  }

  log() {}
  debug() {}
  verbose() {}
  warn(message: unknown, ...rest: unknown[]) {
    this.push("warn", message, rest);
  }

  error(message: unknown, ...rest: unknown[]) {
    this.push("error", message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]) {
    this.push("fatal", message, rest);
  }
}

/** A booted (or failed) application on one adapter. */
export interface Booted {
  /** Which adapter. */
  side: Side;
  /** The application, when `create()` returned one (also after a failed `listen()`). */
  app?: INestApplication;
  /** The Bun adapter, on the Bun side. */
  adapter?: BunHttpAdapter;
  /** `http://127.0.0.1:<port>`, once listening. */
  base?: string;
  /** `<ErrorClass>: <message>` when boot failed. */
  bootError?: string;
  /** What Nest logged at `warn` or above while booting. */
  logs: LogLine[];
}

/**
 * Creates, configures and starts `group` on one adapter, on port 0. A boot
 * error is recorded, not thrown: it is one of the things compared.
 */
export async function boot(side: Side, group: Group): Promise<Booted> {
  const logger = new CaptureLogger();
  // `expressReference()`: platform-express 12.0.0-12.0.1 mount the prefix's
  // not-found router at "api", which Express 5 never matches; the reference
  // carries 12.0.2's fix there, so the comparison tests our adapter, not that
  // bug (see `expressCompat/reference.ts`).
  const adapter =
    side === "express"
      ? expressReference()
      : new BunHttpAdapter(0, group.bunOptions);
  const booted: Booted = { side, logs: logger.lines };
  if (adapter instanceof BunHttpAdapter) booted.adapter = adapter;
  try {
    booted.app = await NestFactory.create(group.module, adapter, {
      logger,
      abortOnError: false,
      ...(group.options as NestApplicationOptions | undefined),
    });
    group.configure?.(booted.app);
    await booted.app.listen(0, "127.0.0.1");
  } catch (error) {
    const err = error as Error | undefined;
    booted.bootError = `${err?.constructor?.name}: ${err?.message ?? String(error)}`;
    await close(booted);
    return booted;
  }
  const port =
    side === "express"
      ? (
          booted.app.getHttpServer() as { address: () => { port: number } }
        ).address().port
      : Number(booted.adapter!.listeningPort);
  booted.base = `http://127.0.0.1:${port}`;
  return booted;
}

/**
 * Closes an application. `app.close()` reaches `BunHttpAdapter.close()`,
 * which stops its server with `stop(true)` (force-close; CLAUDE.md's
 * port-release pitfall), and Express's `server.close()`.
 */
export async function close(booted: Booted | undefined): Promise<void> {
  await booted?.app?.close().catch(() => {});
}

/** Resets Nest's static logger, which `create({ logger })` replaced globally. */
export function resetNestLogger(): void {
  Logger.overrideLogger(false);
}

/** The fields one response is compared on. */
export type Fields = Record<string, string>;

/** Response headers compared, by the field name they are reported under. */
const HEADERS = {
  "content-type": "content-type",
  allow: "allow",
  location: "location",
  "x-custom": "x-custom",
  handler: "x-h",
  trail: "x-trail",
} as const;

/** What a request to an application that failed to boot is reported as. */
export const NO_APP: Fields = { status: "no application (boot failed)" };

/** Reduces a response to the compared fields; absent headers are left out. */
export async function record(res: Response): Promise<Fields> {
  const out: Fields = { status: String(res.status) };
  for (const [field, name] of Object.entries(HEADERS)) {
    const value = res.headers.get(name);
    if (value == null) continue;
    // Bun writes `application/json;charset=utf-8`, Express `; charset=utf-8`.
    out[field] =
      field === "content-type"
        ? value.toLowerCase().replace(/;\s*/g, "; ")
        : value;
  }
  const text = await res.text();
  let body: string;
  try {
    body = text === "" ? "" : JSON.stringify(JSON.parse(text));
  } catch {
    body = text;
  }
  out.body = body;
  return out;
}

/** A timeout, so a hung request fails its test instead of the file. */
function withTimeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The `RequestInit` of a probe. */
function initOf(probe: Probe): RequestInit {
  return {
    method: probe.method ?? "GET",
    headers: probe.headers,
    redirect: "manual",
  };
}

/**
 * Sends `probe` over a raw TCP socket and parses the reply into a
 * `Response`. Used for a path starting with `//`: Bun's `fetch` client sends
 * the request target `//a//b` as `/a//b` (oven-sh/bun#45330; repro in
 * `docs/plans/nestjs-12-parity/evidence/bun-bug-fetch-double-slash/`), so
 * `fetch` cannot deliver it. Remove this once a Bun release with the fix is
 * the floor, and send every probe with `fetch`.
 */
export function rawRequest(base: string, probe: Probe): Promise<Response> {
  const { hostname, port } = new URL(base);
  const headers: Record<string, string> = {
    host: `${hostname}:${port}`,
    connection: "close",
    ...probe.headers,
  };
  const head = [
    `${probe.method ?? "GET"} ${probe.path} HTTP/1.1`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect(Number(port), hostname, () => {
      socket.write(`${head.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (d: Buffer) => chunks.push(d));
    socket.on("error", reject);
    socket.on("close", () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      const lines = all.subarray(0, split).toString("latin1").split("\r\n");
      const status = Number(lines[0].split(" ")[1]);
      const h = new Headers();
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
      }
      let body = all.subarray(split + 4);
      if (h.get("transfer-encoding")?.includes("chunked")) {
        const parts: Buffer[] = [];
        let at = 0;
        for (;;) {
          const eol = body.indexOf("\r\n", at);
          const size = Number.parseInt(body.subarray(at, eol).toString(), 16);
          if (!size) break;
          parts.push(body.subarray(eol + 2, eol + 2 + size));
          at = eol + 2 + size + 2;
        }
        body = Buffer.concat(parts);
      }
      h.delete("transfer-encoding");
      const empty = probe.method === "HEAD" || status === 204 || status === 304;
      resolve(new Response(empty ? null : body, { status, headers: h }));
    });
  });
}

/** Asks an application over its socket; `//` paths go raw. */
export async function viaSocket(booted: Booted, probe: Probe): Promise<Fields> {
  if (!booted.base) return NO_APP;
  const res = probe.path.startsWith("//")
    ? rawRequest(booted.base, probe)
    : fetch(`${booted.base}${probe.path}`, initOf(probe));
  return record(await withTimeout(res));
}

/** Asks the Bun application through its socket-free `adapter.fetch()`. */
export async function viaAdapterFetch(
  booted: Booted,
  probe: Probe,
): Promise<Fields> {
  if (!booted.base || !booted.adapter) return NO_APP;
  // A full URL, so `//a//b` is not read as a protocol-relative URL, and the
  // authority carries the probe's Host.
  const host = probe.headers?.host ?? "127.0.0.1";
  const request = new Request(`http://${host}${probe.path}`, initOf(probe));
  return record(await withTimeout(booted.adapter.fetch(request)));
}

/** A boot reduced to its compared fields. */
export function bootFields(booted: Booted): Fields {
  return {
    "boot-error": booted.bootError ?? "",
    logs: booted.logs.join("\n"),
  };
}
