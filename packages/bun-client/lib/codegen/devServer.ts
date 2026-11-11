/**
 * Finding a running dev server through its token file (typed-client plan
 * §3.3): bun-common's `devTypes()` writes `{ url, ws, token, pid }`, mode
 * `0600`, to `node_modules/.cache/bun-types/<port>.json` (relative to the
 * server's working directory) once it listens, and removes it on close and
 * at exit. `bun-client watch` reads it to find the server and its bearer
 * token, and `bun-client generate --url` reads it to authorize a request to
 * a dev endpoint.
 *
 * Reading is split from deciding: {@link readDevServers} and
 * {@link tokenDirectory} touch the file system; {@link parseTokenFile},
 * {@link devServerFor} and {@link chooseDevServer} are pure.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import process from "node:process";

/** A running dev server, as its token file describes it. */
export interface DevServer {
  /** The documents endpoint: `http://127.0.0.1:<port>/__bun/types` by default. */
  readonly url: string;
  /** The change channel: `ws://127.0.0.1:<port>/__bun/types/ws` by default. */
  readonly ws: string;
  /** The bearer token the endpoint and the channel require. */
  readonly token: string;
  /** The server's process id, when the file names one; a file whose process is gone is skipped. */
  readonly pid?: number;
  /**
   * The named documents it serves (`devTypes()`'s `documents`), each at
   * `<url>/<name>`; absent when it serves none. A watcher following one by
   * name checks it here first.
   */
  readonly documents?: readonly string[];
  /** The token file it was read from, absolute. */
  readonly file: string;
  /** The token file's modification time (epoch milliseconds): newer first when several match. */
  readonly mtimeMs: number;
}

/** Where `devTypes()` writes its token files by default, relative to the server's working directory. */
export const DEFAULT_TOKEN_DIRECTORY = "node_modules/.cache/bun-types";

/** A token `devTypes()` accepts: 16 or more of `[A-Za-z0-9._~-]`. */
const TOKEN_PATTERN = /^[\w.~-]{16,}$/;
/** A document name `devTypes()` accepts. */
export const DOCUMENT_NAME_PATTERN = /^[a-z0-9][\w-]*$/i;

/** Whether `value` is a URL with one of `protocols`. */
function isUrlWith(value: unknown, protocols: readonly string[]): boolean {
  if (typeof value !== "string") return false;
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Reads a token file's text. Pure.
 *
 * @param text The file's content.
 * @param file Its absolute path, recorded on the result.
 * @param mtimeMs Its modification time. Default: `0`.
 * @returns The server, or `undefined` when the text is not a token file
 *   (not JSON, or a field missing or malformed).
 */
export function parseTokenFile(
  text: string,
  file: string,
  mtimeMs = 0,
): DevServer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { url, ws, token, pid, documents } = value as Record<string, unknown>;
  if (
    !isUrlWith(url, ["http:", "https:"]) ||
    !isUrlWith(ws, ["ws:", "wss:"]) ||
    typeof token !== "string" ||
    !TOKEN_PATTERN.test(token)
  ) {
    return undefined;
  }
  return {
    url: url as string,
    ws: ws as string,
    token,
    ...(typeof pid === "number" && Number.isInteger(pid) && pid > 0
      ? { pid }
      : {}),
    // A malformed list is read as none: the file is otherwise usable.
    ...(Array.isArray(documents) &&
    documents.every(
      (name) => typeof name === "string" && DOCUMENT_NAME_PATTERN.test(name),
    )
      ? { documents: documents as string[] }
      : {}),
    file,
    mtimeMs,
  };
}

/** Whether process `pid` is running (a process we may not signal counts as running). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/**
 * The token directory a command run in `cwd` reads: the nearest
 * `node_modules/.cache/bun-types` in `cwd` or an ancestor that exists, so a
 * command run from a subdirectory of the server's project finds it. When
 * none exists yet, `cwd`'s (where a server started there will write).
 */
export function tokenDirectory(cwd: string): string {
  let directory = resolve(cwd);
  for (;;) {
    const candidate = join(directory, DEFAULT_TOKEN_DIRECTORY);
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Not here: try the parent.
    }
    const parent = dirname(directory);
    if (parent === directory)
      return join(resolve(cwd), DEFAULT_TOKEN_DIRECTORY);
    directory = parent;
  }
}

/**
 * Reads the running dev servers a token path names: one token file, or every
 * `*.json` file of a directory. A missing path is no server; an unreadable
 * or malformed file is skipped, and so is one whose `pid` is not running (a
 * server killed before it could remove its file). Newest file first.
 *
 * @param path A token file or a directory of them, absolute.
 * @param alive Whether a process runs. Default: {@link isProcessAlive}.
 */
export async function readDevServers(
  path: string,
  alive: (pid: number) => boolean = isProcessAlive,
): Promise<DevServer[]> {
  let files: string[];
  try {
    const info = await stat(path);
    files = info.isDirectory()
      ? (await readdir(path))
          .filter((name) => extname(name) === ".json")
          .map((name) => join(path, name))
      : [path];
  } catch {
    return [];
  }
  const servers: DevServer[] = [];
  for (const file of files) {
    try {
      const [text, info] = await Promise.all([
        readFile(file, "utf8"),
        stat(file),
      ]);
      const server = parseTokenFile(text, file, info.mtimeMs);
      if (server === undefined) continue;
      if (server.pid !== undefined && !alive(server.pid)) continue;
      servers.push(server);
    } catch {
      // Removed between the listing and the read, or not ours to read.
    }
  }
  return servers.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file),
  );
}

/** The names a loopback host goes by, which all reach the same server. */
function hostKey(hostname: string): string {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  ) {
    return "loopback";
  }
  return host;
}

/** The port a URL dials, its scheme's default when it names none. */
function portOf(url: URL): string {
  if (url.port !== "") return url.port;
  return url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80";
}

/**
 * The server among `servers` that `url` addresses, newest first. Pure.
 *
 * The scheme, port and host must agree (the loopback names — `localhost`,
 * `127.0.0.1`, `[::1]` — counting as one host). With `scope: "endpoint"`,
 * `url`'s path must also be the server's endpoint or under it
 * (`/__bun/types/openapi.json`), so a token is never sent to the app's other
 * routes; with `"origin"`, any path on the server's origin addresses it.
 *
 * @returns The server, or `undefined` when none matches or `url` is not a URL.
 */
export function devServerFor(
  url: string,
  servers: readonly DevServer[],
  scope: "endpoint" | "origin",
): DevServer | undefined {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  return servers.find((server) => {
    const endpoint = new URL(server.url);
    if (
      endpoint.protocol !== target.protocol ||
      portOf(endpoint) !== portOf(target) ||
      hostKey(endpoint.hostname) !== hostKey(target.hostname)
    ) {
      return false;
    }
    if (scope === "origin") return true;
    const base = endpoint.pathname.replace(/\/+$/, "");
    return (
      target.pathname === base ||
      target.pathname === `${base}/` ||
      target.pathname.startsWith(`${base}/`)
    );
  });
}

/** What {@link chooseDevServer} decided. */
export type DevServerChoice =
  | {
      /** One server to use. */
      readonly kind: "one";
      /** The server. */
      readonly server: DevServer;
    }
  | {
      /** No server matches: none is running yet. */
      readonly kind: "none";
    }
  | {
      /** Several run and nothing says which: the user names one with `--url`. */
      readonly kind: "several";
      /** The servers, newest first. */
      readonly servers: readonly DevServer[];
    };

/**
 * Which running server a watcher follows. Pure.
 *
 * - `url` given: the server at that origin (any path), or none.
 * - Otherwise the server the watcher last followed (`last`, its endpoint
 *   URL) while it still runs, so a restart on the same port is followed
 *   even when another server has started meanwhile;
 * - else the only server running; several are `"several"`.
 */
export function chooseDevServer(
  servers: readonly DevServer[],
  options: {
    /** The `--url` the user gave. Default: none. */
    readonly url?: string | undefined;
    /** The endpoint URL followed last. Default: none. */
    readonly last?: string | undefined;
  } = {},
): DevServerChoice {
  if (options.url !== undefined) {
    const server = devServerFor(options.url, servers, "origin");
    return server === undefined ? { kind: "none" } : { kind: "one", server };
  }
  if (options.last !== undefined) {
    const server = servers.find((each) => each.url === options.last);
    if (server !== undefined) return { kind: "one", server };
  }
  const [only, ...others] = servers;
  if (only === undefined) return { kind: "none" };
  if (others.length === 0) return { kind: "one", server: only };
  return { kind: "several", servers };
}
