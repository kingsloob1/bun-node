import type { BunFile } from "bun";
import type { Stats } from "node:fs";
import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type { CompressionEncoding, CompressionMiddleware } from "./compression";
import type {
  NextFunction,
  RouterHandler,
  ServeStaticOptions,
} from "./types/general";
import { stat } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import { basename, join, resolve, sep } from "node:path";
import {
  compression,
  DEFAULT_COMPRESSION_ENCODINGS,
  rankEncodings,
  resolveEncodingOrder,
} from "./compression";
import { encodeUrl } from "./utils/native";

/**
 * Resolved metadata for one static file, cached between requests.
 *
 * `file` is a `Bun.file()` handle rather than the file's bytes — it is a path
 * reference that Bun streams with `sendfile` at send time, so caching it keeps
 * no content in memory and still serves fresh bytes.
 */
interface StaticEntry {
  /** The file handle to send, or `null` when the path resolved to no file. */
  file: BunFile | null;
  /** The resolved absolute path of the file; `""` when none was resolved. */
  path: string;
  /**
   * The served file's `fs.Stats`, handed to `setHeaders` as its `stat`
   * argument; `null` when no file was resolved.
   */
  stats: Stats | null;
  /**
   * `true` when the path, requested without a trailing slash, is a directory —
   * the case `redirect` answers with a 301 to the slashed path.
   */
  directory: boolean;
  /** Byte length, used for `Content-Length`. */
  size: number;
  /** Filesystem mtime in milliseconds, used for `Last-Modified` and the ETag. */
  lastModified: number;
  /** Content type Bun inferred from the extension. */
  type: string;
  /** Weak validator derived from size + mtime; `""` when etags are disabled. */
  etag: string;
  /** Monotonic ms after which this entry must be re-resolved. */
  expiresAt: number;
}

/** Milliseconds a resolved path stays cached when no TTL is configured. */
const DEFAULT_METADATA_TTL_MS = 1000;

/** Entries held before the metadata cache evicts oldest-first. */
const DEFAULT_METADATA_MAX = 1024;

/**
 * The default precompressed sibling extensions per coding: the conventional
 * `.br`, `.zst` and `.gz` (nginx's `brotli_static`/`gzip_static`); none for
 * `deflate`, which has no common one.
 */
const DEFAULT_PRECOMPRESSED_EXTENSIONS: Readonly<
  Record<CompressionEncoding, readonly string[]>
> = {
  br: [".br"],
  zstd: [".zst"],
  gzip: [".gz"],
  deflate: [],
};

/** Multipliers for the `ms`-style suffixes accepted by `maxAge`. */
const MS_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_557_600_000,
};

/**
 * Parses `maxAge` into milliseconds. Accepts a number (already ms) or an
 * `ms`-style string such as `"1d"` / `"30s"`; anything unrecognised is treated
 * as `0`, matching `serve-static`'s "no caching" default.
 */
function parseMaxAge(maxAge: number | string | undefined): number {
  if (typeof maxAge === "number") {
    return Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 0;
  }
  if (typeof maxAge !== "string") {
    return 0;
  }
  // Trim first so the pattern needs no `\s*`; two adjacent `\s*` around an
  // optional group can exchange characters, which is super-linear backtracking.
  const match = /^(\d+(?:\.\d+)?)([a-z]*)$/.exec(maxAge.trim().toLowerCase());
  if (!match) {
    return 0;
  }
  const multiplier = MS_UNITS[match[2] || "ms"];
  return multiplier === undefined ? 0 : Number(match[1]) * multiplier;
}

/**
 * Builds the weak validator Bun itself uses for static files: size and mtime
 * in hex. Both change whenever the bytes change, and neither requires reading
 * the file — which an ETag over the content would. A precompressed sibling's
 * validator also names its coding, so representations never share one.
 */
function buildEtag(
  size: number,
  lastModified: number,
  encoding?: string,
): string {
  const suffix = encoding === undefined ? "" : `-${encoding}`;
  return `W/"${size.toString(16)}-${Math.floor(lastModified).toString(16)}${suffix}"`;
}

/** Escapes the five HTML-significant characters, for the redirect body. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] as string,
  );
}

/** An entry for a path that resolved to nothing servable. */
function emptyEntry(directory: boolean): StaticEntry {
  return {
    file: null,
    path: "",
    stats: null,
    directory,
    size: 0,
    lastModified: 0,
    type: "",
    etag: "",
    expiresAt: 0,
  };
}

/** `fs.stat` that answers `null` instead of throwing for a missing path. */
async function statPath(filePath: string): Promise<Stats | null> {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

/**
 * Splits a URL path into its segments, rejecting any that would escape the
 * root. Percent-escapes are decoded here, so this runs *after* Bun has already
 * normalised the raw path — meaning `%2e%2e` can still decode to `..` and must
 * be caught explicitly.
 *
 * Returns `null` for a malformed escape or a traversal attempt.
 */
function safeSegments(pathname: string): string[] | 400 | 403 | 404 {
  const segments: string[] = [];
  for (const raw of pathname.split("/")) {
    if (raw === "" || raw === ".") {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return 400; // malformed percent-escape, as send
    }
    if (decoded.includes("\0")) {
      return 400; // send refuses a null byte as a bad request
    }
    // Traversal is send's 403, also when smuggled in through an escape.
    if (decoded === ".." || decoded.split(/[\\/]/).includes("..")) {
      return 403;
    }
    // Any other separator smuggled in through an escape names no file here.
    if (decoded.includes("/") || decoded.includes("\\")) {
      return 404;
    }
    segments.push(decoded);
  }
  return segments;
}

/**
 * An `http-errors`-shaped client error, what `send` hands `serve-static` and
 * `serve-static` forwards with `next(err)` when `fallthrough` is `false`.
 */
export class ServeStaticError extends Error {
  /** The HTTP status: 400, 403 or 404. */
  public readonly status: number;
  /** Alias of {@link status}, as `http-errors` sets both. */
  public readonly statusCode: number;
  /** Always `true`: a client error's message is safe to show. */
  public readonly expose = true;

  constructor(
    /** The HTTP status the error carries. */
    status: 400 | 403 | 404,
  ) {
    super(STATUS_CODES[status]);
    this.name =
      status === 400
        ? "BadRequestError"
        : status === 403
          ? "ForbiddenError"
          : "NotFoundError";
    this.status = status;
    this.statusCode = status;
  }
}

/** Normalises the `index` option into the list of filenames to try. */
function resolveIndexNames(index: ServeStaticOptions["index"]): string[] {
  if (index === false) {
    return [];
  }
  if (index === undefined || index === true) {
    return ["index.html"];
  }
  return Array.isArray(index) ? index : [index];
}

/** The resolved `precompressed` option. */
interface PrecompressedConfig {
  /** The codings with extensions, in the server's preference order. */
  order: readonly CompressionEncoding[];
  /** `order` followed by `identity`, for negotiation. */
  provided: readonly string[];
  /** The sibling extensions of each coding in `order`, each with its dot. */
  extensions: ReadonlyMap<CompressionEncoding, readonly string[]>;
  /** See `ServeStaticPrecompressedOptions.fallback`. */
  fallback: "compress" | "identity";
}

/** One sibling extension, with its leading dot; throws for an unusable one. */
function normaliseExtension(extension: string): string {
  const dotted = extension.startsWith(".") ? extension : `.${extension}`;
  if (!/^\.[^/\\\0]+$/.test(dotted)) {
    throw new TypeError(
      `precompressed.extensions: invalid extension "${extension}"`,
    );
  }
  return dotted;
}

/** Resolves `precompressed`; `undefined` when it is off. */
function resolvePrecompressed(
  option: ServeStaticOptions["precompressed"],
): PrecompressedConfig | undefined {
  if (!option) {
    return undefined;
  }
  const options = option === true ? {} : option;
  if (options.enabled === false) {
    return undefined;
  }

  const merged: Partial<
    Record<CompressionEncoding, string | readonly string[]>
  > = { ...DEFAULT_PRECOMPRESSED_EXTENSIONS, ...options.extensions };
  for (const key of Object.keys(merged)) {
    if (!DEFAULT_COMPRESSION_ENCODINGS.includes(key as CompressionEncoding)) {
      throw new TypeError(
        `precompressed.extensions: unknown encoding "${key}"`,
      );
    }
  }

  const extensions = new Map<CompressionEncoding, readonly string[]>();
  for (const encoding of DEFAULT_COMPRESSION_ENCODINGS) {
    const value = merged[encoding];
    const list = (typeof value === "string" ? [value] : (value ?? [])).map(
      normaliseExtension,
    );
    if (list.length > 0) {
      extensions.set(encoding, list);
    }
  }

  const order = resolveEncodingOrder(
    options.encodings ?? "*",
    [...extensions.keys()],
    "precompressed.encodings",
  );
  return {
    order,
    provided: [...order, "identity"],
    extensions,
    fallback: options.fallback ?? "compress",
  };
}

/** Resolves `compression` into the middleware compressing files on the fly. */
function resolveOnTheFly(
  option: ServeStaticOptions["compression"],
): CompressionMiddleware | undefined {
  if (option === false) {
    return undefined;
  }
  return compression(option === true || option === undefined ? {} : option);
}

/** The `next` handed to the on-the-fly middleware, which only registers. */
const ignoreNext: NextFunction = () => undefined;

/**
 * A static-asset handler for `BunRouter`, implementing the `ServeStaticOptions`
 * contract (`serve-static` semantics) on top of `Bun.file`.
 *
 * Shared by `bun-common`'s and `bun-nest`'s `BunHttpAdapter.useStaticAssets`
 * so both behave identically.
 *
 * Semantics that follow `serve-static`:
 *
 * - A client error — a missing file or ignored dotfile (404), a denied
 *   dotfile or traversal attempt (403), a malformed path (400) — calls
 *   `next()` when `fallthrough` is `true` (the default) and `next(err)` with
 *   a {@link ServeStaticError} otherwise.
 * - A method other than `GET`/`HEAD` calls `next()` when `fallthrough` is
 *   `true`; otherwise it is answered `405` with `Allow: GET, HEAD`.
 * - A directory requested without its trailing slash is a `301` to the slashed
 *   path, query string kept (`redirect`, default `true`); with
 *   `redirect: false` it is a miss.
 * - `setHeaders(res, path, stat)` receives the file's `fs.Stats` — for a
 *   precompressed sibling, still the original file's path and stats.
 *
 * Range requests are handled by Bun: a `BunFile` reaches the response intact,
 * and Bun turns a `Range` header into a `206` with `Content-Range` itself.
 *
 * Beyond `serve-static`: `precompressed` serves `.br`/`.zst`/`.gz` siblings,
 * and `compression` (on by default) compresses the rest on the fly — see
 * {@link ServeStaticOptions}.
 *
 * @param root    Directory served, resolved once at registration.
 * @param options `serve-static`-shaped options; see {@link ServeStaticOptions}.
 */
export function createServeStaticHandler(
  root: string,
  options: ServeStaticOptions = {},
): { prefix: string; handler: RouterHandler } {
  // Resolve once — every request compares against this to stay inside the root.
  const rootPath = resolve(root);
  const rootWithSep = rootPath.endsWith(sep) ? rootPath : rootPath + sep;

  // The prefix is matched case-insensitively (it is part of the URL space we
  // own) but never applied to the filesystem path, which stays byte-exact.
  const rawPrefix = String(options.prefix || "");
  const prefix = rawPrefix.endsWith("/") ? rawPrefix.slice(0, -1) : rawPrefix;
  const prefixLower = prefix.toLowerCase();

  const etagEnabled = options.etag ?? true;
  const lastModifiedEnabled = options.lastModified ?? true;
  const dotfiles = options.dotfiles ?? "ignore";
  // serve-static: `opts.fallthrough !== false`.
  const fallthrough = options.fallthrough !== false;
  const redirect = options.redirect ?? true;
  const indexNames = resolveIndexNames(options.index);
  const extensions = options.extensions ?? [];
  const setHeaders = options.setHeaders;
  const precompressed = resolvePrecompressed(options.precompressed);
  const onTheFly = resolveOnTheFly(options.compression);

  const maxAgeMs = parseMaxAge(options.maxAge);
  const cacheControl =
    maxAgeMs > 0
      ? `public, max-age=${Math.floor(maxAgeMs / 1000)}${options.immutable ? ", immutable" : ""}`
      : undefined;

  const ttl = options.metadataCacheTtl ?? DEFAULT_METADATA_TTL_MS;
  const cacheMax = options.metadataCacheMax ?? DEFAULT_METADATA_MAX;
  const cacheEnabled = ttl > 0 && cacheMax > 0;
  // Keyed by the resolved absolute path. Static trees are small and bounded,
  // so unlike the route cache this cannot be blown out by request cardinality.
  const metadata = new Map<string, StaticEntry>();

  /** Whether an absolute path is the root or inside it. */
  function isInsideRoot(filePath: string): boolean {
    return filePath === rootPath || filePath.startsWith(rootWithSep);
  }

  /** Builds the entry for a stat that is a plain file. */
  function fileEntry(filePath: string, stats: Stats): StaticEntry {
    const file = Bun.file(filePath);
    const size = stats.size;
    const lastModified = stats.mtimeMs;
    return {
      file,
      path: filePath,
      stats,
      directory: false,
      size,
      lastModified,
      // Inferred from the extension alone — no filesystem call.
      type: file.type || "application/octet-stream",
      etag: etagEnabled ? buildEtag(size, lastModified) : "",
      expiresAt: 0,
    };
  }

  /** Stats one candidate path, or returns `null` when it is not a plain file. */
  async function statFile(filePath: string): Promise<StaticEntry | null> {
    const stats = await statPath(filePath);
    return stats?.isFile() ? fileEntry(filePath, stats) : null;
  }

  /** Remembers `entry` under `key` for `ttl` ms, evicting oldest-first. */
  function remember(key: string, entry: StaticEntry, now: number): void {
    entry.expiresAt = now + ttl;
    if (!cacheEnabled) {
      return;
    }
    if (metadata.size >= cacheMax) {
      const oldest = metadata.keys().next().value;
      if (oldest !== undefined) {
        metadata.delete(oldest);
      }
    }
    metadata.set(key, entry);
  }

  /** A fresh cached entry for `key`, or `undefined`. */
  function recall(key: string, now: number): StaticEntry | undefined {
    if (!cacheEnabled) {
      return undefined;
    }
    const cached = metadata.get(key);
    return cached !== undefined && cached.expiresAt > now ? cached : undefined;
  }

  /**
   * Resolves a request path to a file the way `send` (under `serve-static`)
   * does:
   *
   * - with a trailing slash, each `index` name is tried inside the directory;
   * - without one, the exact path is served when it is a file, reported as a
   *   `directory` (for `redirect`) when it is a directory, and otherwise each
   *   `extensions` fallback is tried.
   *
   * Results (including misses) are memoised for `ttl` ms so a hot asset costs
   * no filesystem call at all.
   */
  async function resolveEntry(
    filePath: string,
    isDirectoryRequest: boolean,
  ): Promise<StaticEntry> {
    const now = Date.now();
    // `resolve()` strips a trailing slash, so `/guide` and `/guide/` share a
    // filePath — yet resolve differently. Key them apart.
    const cacheKey = isDirectoryRequest ? `${filePath}${sep}` : filePath;
    const cached = recall(cacheKey, now);
    if (cached) {
      return cached;
    }

    let entry: StaticEntry | null = null;

    if (isDirectoryRequest) {
      // Directory: try each configured index file.
      for (const name of indexNames) {
        entry = await statFile(join(filePath, name));
        if (entry) {
          break;
        }
      }
    } else {
      const stats = await statPath(filePath);
      if (stats?.isFile()) {
        entry = fileEntry(filePath, stats);
      } else if (stats?.isDirectory()) {
        entry = emptyEntry(true);
      } else {
        // Extension fallbacks: /about -> /about.html
        for (const extension of extensions) {
          const suffix = extension.startsWith(".")
            ? extension
            : `.${extension}`;
          entry = await statFile(filePath + suffix);
          if (entry) {
            break;
          }
        }
      }
    }

    const resolved: StaticEntry = entry ?? emptyEntry(false);
    remember(cacheKey, resolved, now);
    return resolved;
  }

  /**
   * The precompressed sibling at `siblingPath`, or `null`. It is held to the
   * checks the original passed — inside the root, and not a dotfile unless
   * dotfiles are allowed — and memoised like any other entry.
   */
  async function resolveSibling(
    siblingPath: string,
  ): Promise<StaticEntry | null> {
    if (
      !isInsideRoot(siblingPath) ||
      (dotfiles !== "allow" && basename(siblingPath).startsWith("."))
    ) {
      return null;
    }
    const now = Date.now();
    // Absolute paths never start with a space, so these keys cannot collide.
    const cacheKey = ` sibling ${siblingPath}`;
    const cached = recall(cacheKey, now);
    if (cached) {
      return cached.file ? cached : null;
    }
    const entry = await statFile(siblingPath);
    remember(cacheKey, entry ?? emptyEntry(false), now);
    return entry;
  }

  /**
   * The best precompressed sibling of `entry` the request accepts: codings
   * in negotiated order, each coding's extensions in order, the first that
   * exists. `identity` ranking above a coding ends the search.
   */
  async function findPrecompressed(
    config: PrecompressedConfig,
    req: BunRequest,
    entry: StaticEntry,
  ): Promise<{ encoding: CompressionEncoding; sibling: StaticEntry } | null> {
    const accept = req.getHeader("Accept-Encoding");
    if (!accept) {
      return null;
    }
    for (const encoding of rankEncodings(
      accept,
      config.provided,
      config.order,
    )) {
      if (encoding === "identity") {
        return null;
      }
      const coding = encoding as CompressionEncoding;
      for (const extension of config.extensions.get(coding) ?? []) {
        const sibling = await resolveSibling(entry.path + extension);
        if (sibling) {
          return { encoding: coding, sibling };
        }
      }
    }
    return null;
  }

  const handler: RouterHandler = async (
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
  ) => {
    /**
     * A client error, as serve-static's `error` listener: `next()` when
     * falling through, `next(err)` otherwise.
     */
    const fail = (status: 400 | 403 | 404) =>
      fallthrough ? next() : next(new ServeStaticError(status));
    /** A path that resolves to nothing. */
    const miss = () => fail(404);

    if (req.method !== "GET" && req.method !== "HEAD") {
      if (fallthrough) {
        return next();
      }
      // Method not allowed, exactly as serve-static answers it.
      res.setHeader("Allow", "GET, HEAD");
      res.setHeader("Content-Length", "0");
      return res.status(405).end();
    }

    let pathname = req.path;
    // Strip the mount prefix. Compared lower-cased because the prefix belongs
    // to the URL space; the remainder keeps its original case so files like
    // `Logo.PNG` stay reachable on a case-sensitive filesystem.
    if (prefixLower && pathname.toLowerCase().startsWith(prefixLower)) {
      pathname = pathname.slice(prefix.length);
    }

    // `""` is the mount itself (`/static` under prefix `/static`): like
    // serve-static, a directory requested without its slash.
    const isDirectoryRequest = pathname.endsWith("/");

    const segments = safeSegments(pathname);
    if (!Array.isArray(segments)) {
      return fail(segments);
    }

    if (dotfiles !== "allow") {
      for (const segment of segments) {
        if (segment.startsWith(".")) {
          // send: `deny` is a 403 error, `ignore` a 404 — both client errors.
          return fail(dotfiles === "deny" ? 403 : 404);
        }
      }
    }

    const filePath = resolve(join(rootPath, ...segments));
    // Defence in depth: after decoding, confirm the path is still inside root.
    if (!isInsideRoot(filePath)) {
      return miss();
    }

    const entry = await resolveEntry(filePath, isDirectoryRequest);
    if (!entry.file || !entry.stats) {
      if (entry.directory && redirect) {
        // serve-static: 301 to the path with a trailing slash, query kept.
        const location = `${encodeUrl(
          `${req.path}/`.replace(/^\/+/, "/"),
        )}${req.search}`;
        const escaped = escapeHtml(location);
        res.setHeader("Content-Type", "text/html; charset=UTF-8");
        res.setHeader("Content-Security-Policy", "default-src 'none'");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Location", location);
        return res
          .status(301)
          .send(
            `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Redirecting</title>\n</head>\n<body>\n<pre>Redirecting to <a href="${escaped}">${escaped}</a></pre>\n</body>\n</html>\n`,
          );
      }
      // A directory with `redirect: false` is a miss, as in serve-static.
      return miss();
    }

    const found = precompressed
      ? await findPrecompressed(precompressed, req, entry)
      : null;
    // The file actually sent: the sibling when one is served.
    const sent = found?.sibling ?? entry;

    // The original's type, never the sibling's `application/gzip`.
    res.setHeader("Content-Type", entry.type);
    res.setHeader("Content-Length", String(sent.size));
    // Advertise range support even on the full response, so clients know they
    // may resume; Bun supplies the 206 itself when a Range header arrives.
    res.setHeader("Accept-Ranges", "bytes");

    if (precompressed) {
      res.vary("Accept-Encoding");
    }
    if (found) {
      res.setHeader("Content-Encoding", found.encoding);
    }

    if (lastModifiedEnabled) {
      res.setHeader("Last-Modified", new Date(sent.lastModified).toUTCString());
    }
    if (etagEnabled) {
      res.setHeader(
        "ETag",
        found
          ? buildEtag(sent.size, sent.lastModified, found.encoding)
          : entry.etag,
      );
    }
    if (cacheControl) {
      res.setHeader("Cache-Control", cacheControl);
    }
    if (setHeaders) {
      setHeaders(res, filePath, entry.stats);
    }

    if (
      !found &&
      onTheFly &&
      (precompressed === undefined || precompressed.fallback === "compress")
    ) {
      // Registers the transform that compresses the file as it is sent.
      onTheFly(req, res, ignoreNext);
    }

    // `send` turns this into a 304 by itself when the request's validators
    // match (see `BunRequest.fresh`), so conditional requests need no work here.
    return res.status(200).send(sent.file);
  };

  return { prefix, handler };
}
