/**
 * Shared probe harness: builds a Nest app on ExpressAdapter or BunHttpAdapter,
 * gives a request function (bun: socket-free adapter.fetch(); express: served
 * on 127.0.0.1:0), and snapshots responses. Run probes from this directory
 * (Bun reads decorator options from the cwd's tsconfig).
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { createRequire } from "node:module";

export type Kind = "express" | "bun";
export const kind = (process.argv[2] ?? "bun") as Kind;

const req = createRequire(import.meta.url);
export function nestVersion(pkg = "@nestjs/core"): string {
  try {
    return req(`${pkg}/package.json`).version;
  } catch {
    return "absent";
  }
}

export interface Built {
  app: any;
  adapter: any;
  /** Request a path; bun uses adapter.fetch() unless served, express is always served. */
  request: (path: string, init?: RequestInit) => Promise<Response>;
  url?: string;
  close: () => Promise<void>;
}

export async function build(
  module: any,
  options: Record<string, unknown> = {},
  opts: {
    bunOptions?: any;
    served?: boolean;
    setup?: (app: any) => void | Promise<void>;
    express?: () => any;
  } = {},
): Promise<Built> {
  let adapter: any;
  if (kind === "bun") {
    const { BunHttpAdapter } = await import("@kingsleyweb/bun-nest");
    adapter = new BunHttpAdapter(0, opts.bunOptions);
  } else {
    const { ExpressAdapter } = await import("@nestjs/platform-express");
    adapter = opts.express ? opts.express() : new ExpressAdapter();
  }
  const app = await NestFactory.create(module, adapter, {
    logger: false,
    abortOnError: false,
    ...options,
  });
  if (opts.setup) await opts.setup(app);
  let url: string | undefined;
  if (kind === "express" || opts.served) {
    await app.listen(0, "127.0.0.1");
    url = await app.getUrl();
  } else {
    await app.init();
  }
  const request = (path: string, init?: RequestInit) =>
    url ? fetch(url + path, init) : adapter.fetch(path, init);
  return {
    app,
    adapter,
    request,
    url,
    close: async () => {
      await app.close();
    },
  };
}

const SKIP_HEADERS = new Set(["date", "keep-alive", "connection", "etag"]);

export async function snap(res: Response, bodyLimit = 600) {
  const headers: Record<string, string | string[]> = {};
  res.headers.forEach((v, k) => {
    if (!SKIP_HEADERS.has(k) && k !== "set-cookie") headers[k] = v;
  });
  const cookies = res.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  const text = await res.text();
  return {
    status: res.status,
    headers,
    body: text.length > bodyLimit ? `${text.slice(0, bodyLimit)}…(${text.length})` : text,
  };
}

/** Runs each case, catching errors, and prints one JSON document. */
export async function runCases(
  name: string,
  cases: Record<string, () => Promise<unknown>>,
  /** Runs after the cases, before the JSON is printed (e.g. closing a shared app). */
  after?: () => Promise<unknown>,
) {
  const out: Record<string, unknown> = {
    probe: name,
    kind,
    nest: nestVersion(),
    platformExpress: nestVersion("@nestjs/platform-express"),
    bun: Bun.version,
  };
  for (const [key, fn] of Object.entries(cases)) {
    try {
      out[key] = await withDeadline(fn(), 15000);
    } catch (error) {
      out[key] = {
        threw: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error),
      };
    }
  }
  if (after) await after().catch((e) => (out.afterThrew = String(e)));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

export async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | { timeout: number }> {
  let t: any;
  try {
    return await Promise.race([p, new Promise<{ timeout: number }>((r) => (t = setTimeout(r, ms, { timeout: ms })))]);
  } finally {
    clearTimeout(t);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
