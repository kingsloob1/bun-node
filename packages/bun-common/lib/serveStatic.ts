import type { BunFile } from "bun";
import type { BunRequest } from "./BunRequest";
import type { BunResponse } from "./BunResponse";
import type {
  NextFunction,
  RouterHandler,
  ServeStaticOptions,
} from "./types/general";
import { join, resolve, sep } from "node:path";

/**
 * Resolved metadata for one static file, cached between requests.
 *
 * `file` is a `Bun.file()` handle rather than the file's bytes — it is a path
 * reference that Bun streams with `sendfile` at send time, so caching it keeps
 * no content in memory and still serves fresh bytes.
 */
interface StaticEntry {
  /** The file handle to send, or `null` when the path resolved to nothing. */
  file: BunFile | null;
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
 * the file — which an ETag over the content would.
 */
function buildEtag(size: number, lastModified: number): string {
  return `W/"${size.toString(16)}-${Math.floor(lastModified).toString(16)}"`;
}

/**
 * Splits a URL path into its segments, rejecting any that would escape the
 * root. Percent-escapes are decoded here, so this runs *after* Bun has already
 * normalised the raw path — meaning `%2e%2e` can still decode to `..` and must
 * be caught explicitly.
 *
 * Returns `null` for a malformed escape or a traversal attempt.
 */
function safeSegments(pathname: string): string[] | null {
  const segments: string[] = [];
  for (const raw of pathname.split("/")) {
    if (raw === "" || raw === ".") {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null; // malformed percent-escape
    }
    // Reject traversal and any separator smuggled in through an escape.
    if (
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      return null;
    }
    segments.push(decoded);
  }
  return segments;
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

/**
 * A static-asset handler for `BunRouter`, implementing the `ServeStaticOptions`
 * contract (`serve-static` semantics) on top of `Bun.file`.
 *
 * Shared by `bun-common`'s and `bun-nest`'s `BunHttpAdapter.useStaticAssets`
 * so both behave identically.
 *
 * Range requests are handled by Bun: a `BunFile` reaches the response intact,
 * and Bun turns a `Range` header into a `206` with `Content-Range` itself.
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
  const fallthrough = options.fallthrough ?? false;
  const indexNames = resolveIndexNames(options.index);
  const extensions = options.extensions ?? [];
  const setHeaders = options.setHeaders;

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

  /** Stats one candidate path, or returns `null` when it is not a plain file. */
  async function statFile(filePath: string): Promise<StaticEntry | null> {
    const file = Bun.file(filePath);
    // `exists()` is false for directories as well as missing paths, which is
    // exactly the "not a servable file" test we want — and it populates the
    // handle's stat cache, so `size`/`lastModified`/`type` below are free.
    if (!(await file.exists())) {
      return null;
    }
    const size = file.size;
    const lastModified = file.lastModified;
    return {
      file,
      size,
      lastModified,
      type: file.type || "application/octet-stream",
      etag: etagEnabled ? buildEtag(size, lastModified) : "",
      expiresAt: 0,
    };
  }

  /**
   * Resolves a request path to a file, applying the index and extension
   * fallbacks. Results (including misses) are memoised for `ttl` ms so a hot
   * asset costs no filesystem call at all.
   */
  async function resolveEntry(
    filePath: string,
    isDirectoryRequest: boolean,
  ): Promise<StaticEntry> {
    const now = Date.now();

    if (cacheEnabled) {
      const cached = metadata.get(filePath);
      if (cached !== undefined && cached.expiresAt > now) {
        return cached;
      }
    }

    let entry: StaticEntry | null = null;

    // A path ending in "/" is only ever a directory — skip the file attempt.
    if (!isDirectoryRequest) {
      entry = await statFile(filePath);

      // Extension fallbacks: /about -> /about.html
      if (!entry) {
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

    // Directory (or unresolved path): try each configured index file.
    if (!entry) {
      for (const name of indexNames) {
        entry = await statFile(join(filePath, name));
        if (entry) {
          break;
        }
      }
    }

    const resolved: StaticEntry = entry ?? {
      file: null,
      size: 0,
      lastModified: 0,
      type: "",
      etag: "",
      expiresAt: 0,
    };
    resolved.expiresAt = now + ttl;

    if (cacheEnabled) {
      if (metadata.size >= cacheMax) {
        const oldest = metadata.keys().next().value;
        if (oldest !== undefined) {
          metadata.delete(oldest);
        }
      }
      metadata.set(filePath, resolved);
    }

    return resolved;
  }

  const handler: RouterHandler = async (
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
  ) => {
    /** Ends a non-match as a 404, or hands back to the pipeline. */
    const miss = () => {
      if (fallthrough) {
        return next();
      }
      return res.status(404).send("Not Found");
    };

    let pathname = req.path;
    // Strip the mount prefix. Compared lower-cased because the prefix belongs
    // to the URL space; the remainder keeps its original case so files like
    // `Logo.PNG` stay reachable on a case-sensitive filesystem.
    if (prefixLower && pathname.toLowerCase().startsWith(prefixLower)) {
      pathname = pathname.slice(prefix.length);
    }

    const isDirectoryRequest = pathname === "" || pathname.endsWith("/");

    const segments = safeSegments(pathname);
    if (segments === null) {
      return miss();
    }

    if (dotfiles !== "allow") {
      for (const segment of segments) {
        if (segment.startsWith(".")) {
          return dotfiles === "deny"
            ? res.status(403).send("Forbidden")
            : miss();
        }
      }
    }

    const filePath = resolve(join(rootPath, ...segments));
    // Defence in depth: after decoding, confirm the path is still inside root.
    if (filePath !== rootPath && !filePath.startsWith(rootWithSep)) {
      return miss();
    }

    const entry = await resolveEntry(filePath, isDirectoryRequest);
    if (!entry.file) {
      return miss();
    }

    res.setHeader("Content-Type", entry.type);
    res.setHeader("Content-Length", String(entry.size));
    // Advertise range support even on the full response, so clients know they
    // may resume; Bun supplies the 206 itself when a Range header arrives.
    res.setHeader("Accept-Ranges", "bytes");

    if (lastModifiedEnabled) {
      res.setHeader(
        "Last-Modified",
        new Date(entry.lastModified).toUTCString(),
      );
    }
    if (entry.etag) {
      res.setHeader("ETag", entry.etag);
    }
    if (cacheControl) {
      res.setHeader("Cache-Control", cacheControl);
    }
    if (setHeaders) {
      setHeaders(res, filePath, entry);
    }

    // `send` turns this into a 304 by itself when the request's validators
    // match (see `BunRequest.fresh`), so conditional requests need no work here.
    return res.status(200).send(entry.file);
  };

  return { prefix, handler };
}
