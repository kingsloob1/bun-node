/**
 * The Cloudflare KV driver (plan Status: PR-C10; the spike,
 * `docs/plans/bun-cache/evidence/cloudflare-spike.md`), over HTTP: the REST
 * API with an API token, or the bun-cache Worker
 * (`@kingsleyweb/bun-cache/cloudflare-worker`) with its secret — the README
 * recommends the Worker for production, since the REST API is capped at
 * 1,200 requests per five minutes per token (`../cloudflare/client.ts`).
 *
 * **Layout** (`<p>` the prefix, `bun-cache` by default; `<ns>` the namespace
 * through `encodeSegment`, so it never adds a `/`):
 *
 * ```
 * <p>/<ns>/e/<sha256(key)>   an entry: the frame (expiry, tags) and the core's bytes
 * <p>/<ns>/s/<sha256(tag)>   a tag stamp, JSON { at, until }
 * ```
 *
 * Keys are hashed, so none exceeds KV's 512 bytes whatever the cache key.
 *
 * - **Expiry** is KV's own (`ttl: "native"`): every write carries
 *   `expiration_ttl`, never under KV's floor of 60 s. A shorter expiry is
 *   exact anyway — the frame holds `expiresAt` and every read checks it — and
 *   KV reclaims the key up to a minute later. No sweeper.
 * - **Values are raw bytes**: `get` is one `GET`, `getMany` parallel `GET`s
 *   (KV's `bulk/get` refuses binary values); `setMany` one bulk write per
 *   10,000 pairs. `delete` reads each key first (KV answers a delete alike
 *   either way, and the count must be exact), then one bulk delete.
 * - **Tags are `stamps`** (§3.6): one stamp per invalidated tag, read back in
 *   one `bulk/get` per 100 tags; the core's read check does the
 *   invalidating. KV has no compare-and-swap, so a stamp is read and written
 *   forward (the later `at` kept), which narrows but cannot close the window
 *   where two invalidations of one tag land out of order.
 * - **No counters, no locks, no bus** (`atomicIncrement`, `lock` false, `bus:
 *   "none"`): KV has neither an atomic increment nor a conditional write.
 *   `increment` throws `UnsupportedOperationError`; `getOrSet` keeps its
 *   in-process single-flight only.
 * - **Consistency**: KV is eventually consistent. A write, a delete or an
 *   invalidation is usually seen at once where it was made, and may take a
 *   minute or more elsewhere; KV also allows one write per second to a key
 *   (429 otherwise, which the client retries).
 */
import type {
  CacheDriver,
  CacheDriverCapabilities,
  SchemaChange,
  SchemaSyncOptions,
  StoredEntry,
  TagFence,
} from "../core/types";
import type { KvBulkPair } from "../cloudflare/client";
import { CloudflareClient } from "../cloudflare/client";
import { encodeSegment } from "./file-names";

/** The default key prefix (§7, §21). */
export const DEFAULT_CLOUDFLARE_KV_PREFIX = "bun-cache";

/** The frame's magic, "BK". */
const FRAME_MAGIC = [0x42, 0x4b];

/** The frame format's version byte. */
const FRAME_FORMAT = 1;

/** The fixed part of the frame: magic, format, a reserved byte, expiresAt f64, the tag count u16. */
const FRAME_HEAD = 2 + 1 + 1 + 8 + 2;

/** The sentinel for "no expiry" in the frame's `expiresAt` slot. */
const NO_EXPIRY = -1;

/** KV's value limit is 25 MiB; a MiB is left for the frame's header and tags. */
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;

/** How many requests one operation keeps in flight at once (`getMany`, `delete`'s reads). */
const CONCURRENCY = 16;

/** The longest prefix accepted, in UTF-8 bytes, so a key stays well under KV's 512. */
const MAX_PREFIX_BYTES = 200;

/** `cloudflareKvDriver()`'s options: where the namespace is, and the driver's own. */
export interface CloudflareKvDriverOptions {
  /** The account's id, for the REST API; `CLOUDFLARE_ACCOUNT_ID` when absent. Ignored with an `endpoint`. */
  accountId?: string;
  /**
   * The bearer token: an API token with *Workers KV Storage: Edit* for the
   * REST API (`CLOUDFLARE_API_TOKEN` when absent), or, with an `endpoint`,
   * the Worker's `BUN_CACHE_PROXY_TOKEN` secret — then required here: the
   * environment's API token is never sent to a Worker.
   */
  apiToken?: string;
  /**
   * The namespace: its id for the REST API, or its **binding name** in the
   * Worker's `wrangler.toml` with an `endpoint` (e.g. `"CACHE_KV"`).
   */
  namespaceId: string;
  /**
   * The bun-cache Worker's URL (`https://bun-cache.<you>.workers.dev`); the
   * REST API when absent. `https:`, or `http:` to a loopback host. The
   * README recommends the Worker for production: the REST API is capped at
   * 1,200 requests per five minutes per token.
   */
  endpoint?: string;
  /**
   * Prepended to every key (`<prefix>/<ns>/…`). Defaults to `bun-cache`.
   * Must not be empty, start with `/`, or exceed 200 bytes; a trailing `/` is
   * dropped. Give each cache sharing a namespace a prefix of its own.
   */
  prefix?: string;
  /** The clock, epoch ms. Internal: for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** A stamp's value. */
interface StampBody {
  /** When the tag was invalidated, epoch ms. */
  at: number;
  /** When the stamp itself lapses, epoch ms. */
  until: number;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Hashes a name (a key or a tag) for its KV key. */
function hash(name: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(name);
  return hasher.digest("hex");
}

/** Encodes an entry's frame. */
export function encodeKvEntry(entry: StoredEntry): Uint8Array {
  const tags = entry.tags.map((tag) => ENCODER.encode(tag));
  const tagsLength = tags.reduce((total, tag) => total + 2 + tag.length, 0);
  const out = new Uint8Array(FRAME_HEAD + tagsLength + entry.value.length);
  const view = new DataView(out.buffer);
  out[0] = FRAME_MAGIC[0];
  out[1] = FRAME_MAGIC[1];
  out[2] = FRAME_FORMAT;
  view.setFloat64(4, entry.expiresAt ?? NO_EXPIRY, true);
  view.setUint16(12, tags.length, true);
  let offset = FRAME_HEAD;
  for (const tag of tags) {
    view.setUint16(offset, tag.length, true);
    out.set(tag, offset + 2);
    offset += 2 + tag.length;
  }
  out.set(entry.value, offset);
  return out;
}

/** Decodes an entry's frame; `undefined` when the bytes are not one. */
export function decodeKvEntry(
  key: string,
  bytes: Uint8Array,
): StoredEntry | undefined {
  if (
    bytes.length < FRAME_HEAD ||
    bytes[0] !== FRAME_MAGIC[0] ||
    bytes[1] !== FRAME_MAGIC[1] ||
    bytes[2] !== FRAME_FORMAT
  ) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expiresAt = view.getFloat64(4, true);
  const count = view.getUint16(12, true);
  let offset = FRAME_HEAD;
  const tags: string[] = [];
  for (let index = 0; index < count; index++) {
    if (offset + 2 > bytes.length) {
      return undefined;
    }
    const length = view.getUint16(offset, true);
    if (offset + 2 + length > bytes.length) {
      return undefined;
    }
    tags.push(DECODER.decode(bytes.subarray(offset + 2, offset + 2 + length)));
    offset += 2 + length;
  }
  return {
    key,
    value: bytes.slice(offset),
    expiresAt: expiresAt === NO_EXPIRY ? null : expiresAt,
    tags,
  };
}

/** Runs `run` over `items`, at most `limit` at a time; answers the results in order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = Array.from<R>({ length: items.length });
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await run(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/** Reads a stamp's JSON; `undefined` when it is not one. */
function parseStamp(text: string | undefined): StampBody | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as Partial<StampBody>;
    return typeof parsed.at === "number" && typeof parsed.until === "number"
      ? { at: parsed.at, until: parsed.until }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The Cloudflare KV driver. See the module header and {@link CloudflareKvDriverOptions}. */
export class CloudflareKvCacheDriver implements CacheDriver {
  /** `"cloudflare-kv"`. */
  readonly name = "cloudflare-kv";

  /** KV's own expiry, stamp-mode tags, no counters, locks or bus (plan Status, PR-C10). */
  readonly capabilities: CacheDriverCapabilities = {
    multiProcess: true,
    ttl: "native",
    atomicIncrement: false,
    lock: false,
    tags: "stamps",
    fence: "atomic",
    bus: "none",
    maxEntryBytes: MAX_ENTRY_BYTES,
  };

  /** The key prefix, as resolved. Internal; read by the tests. */
  readonly prefix: string;

  /** The HTTP client (REST API or Worker). Internal; read by the tests. */
  readonly client: CloudflareClient;

  /** The namespace id, or the Worker's binding name. */
  readonly #namespaceId: string;

  /** The clock. */
  readonly #now: () => number;

  /** The connect check (one listing), shared; cleared when it fails. */
  #connected: Promise<void> | undefined;

  /** Set once `close()` ran. */
  #closed = false;

  constructor(
    /** Where the namespace is, and the driver's own options. */ options: CloudflareKvDriverOptions,
  ) {
    if (typeof options.namespaceId !== "string" || options.namespaceId === "") {
      throw new TypeError(
        "cloudflareKvDriver needs namespaceId: the namespace's id (REST API) or its binding name (Worker)",
      );
    }
    const prefix = (options.prefix ?? DEFAULT_CLOUDFLARE_KV_PREFIX).replace(
      /\/+$/,
      "",
    );
    if (
      prefix === "" ||
      prefix.startsWith("/") ||
      ENCODER.encode(prefix).length > MAX_PREFIX_BYTES
    ) {
      throw new TypeError(
        `cloudflareKvDriver: prefix must not be empty, start with /, or exceed ${MAX_PREFIX_BYTES} bytes; got ${JSON.stringify(options.prefix)}`,
      );
    }
    this.prefix = prefix;
    this.#namespaceId = options.namespaceId;
    this.#now = options.now ?? Date.now;
    this.client = new CloudflareClient({
      accountId: options.accountId,
      apiToken: options.apiToken,
      endpoint: options.endpoint,
      caller: "cloudflareKvDriver",
    });
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Checks the namespace answers (one listing under the prefix). Idempotent; nothing waits for it. */
  async connect(): Promise<void> {
    this.#assertOpen();
    this.#connected ??= this.ping().catch((error: unknown) => {
      this.#connected = undefined;
      throw error;
    });
    await this.#connected;
  }

  /** Nothing to close: `fetch` holds no connection the driver owns. Further operations throw. */
  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }

  /** One listing of at most ten keys (KV's smallest page). */
  async ping(): Promise<void> {
    await this.client.kvList(this.#namespaceId, `${this.prefix}/`, {
      limit: 10,
    });
  }

  /** Throws once the driver is closed. */
  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("the cloudflare-kv cache driver is closed");
    }
  }

  /* ---------------------------------------------------------------- */
  /* keys                                                              */
  /* ---------------------------------------------------------------- */

  /** The namespace's key prefix. */
  #nsPath(ns: string): string {
    return `${this.prefix}/${encodeSegment(ns)}`;
  }

  /** An entry's KV key. */
  #entryKey(ns: string, key: string): string {
    return `${this.#nsPath(ns)}/e/${hash(key)}`;
  }

  /** A tag stamp's KV key. */
  #stampKey(ns: string, tag: string): string {
    return `${this.#nsPath(ns)}/s/${hash(tag)}`;
  }

  /* ---------------------------------------------------------------- */
  /* entries                                                           */
  /* ---------------------------------------------------------------- */

  async get(ns: string, key: string): Promise<StoredEntry | undefined> {
    this.#assertOpen();
    const bytes = await this.client.kvGet(
      this.#namespaceId,
      this.#entryKey(ns, key),
    );
    if (bytes === undefined) {
      return undefined;
    }
    const entry = decodeKvEntry(key, bytes);
    if (
      entry === undefined ||
      (entry.expiresAt !== null && entry.expiresAt <= this.#now())
    ) {
      // An expired entry is KV's to reclaim (within a minute of its floor).
      return undefined;
    }
    return entry;
  }

  async getMany(
    ns: string,
    keys: readonly string[],
  ): Promise<(StoredEntry | undefined)[]> {
    return await mapLimit(
      keys,
      CONCURRENCY,
      async (key) => await this.get(ns, key),
    );
  }

  async set(
    ns: string,
    entry: StoredEntry,
    fence?: TagFence,
  ): Promise<"stored" | "fenced"> {
    // Stamps mode (§3.6): no write fence — the read-side check sees a stamp
    // whatever order the writes landed in.
    void fence;
    this.#assertOpen();
    await this.client.kvPut(
      this.#namespaceId,
      this.#entryKey(ns, entry.key),
      encodeKvEntry(entry),
      entry.expiresAt,
      this.#now(),
    );
    return "stored";
  }

  /** One bulk write per 10,000 entries (KV's limit). */
  async setMany(ns: string, entries: readonly StoredEntry[]): Promise<void> {
    this.#assertOpen();
    if (entries.length === 0) {
      return;
    }
    const pairs: KvBulkPair[] = entries.map((entry) => ({
      key: this.#entryKey(ns, entry.key),
      value: encodeKvEntry(entry),
      expiresAt: entry.expiresAt,
    }));
    await this.client.kvBulkPut(this.#namespaceId, pairs, this.#now());
  }

  /**
   * Deletes entries: a read per key first (KV answers a delete alike whether
   * or not the key was there, and the count must be exact), then one bulk
   * delete of the ones found.
   */
  async delete(ns: string, keys: readonly string[]): Promise<number> {
    this.#assertOpen();
    const unique = [...new Set(keys)].map((key) => this.#entryKey(ns, key));
    const present = await mapLimit(
      unique,
      CONCURRENCY,
      async (kvKey) => await this.client.kvExists(this.#namespaceId, kvKey),
    );
    const found = unique.filter((_, index) => present[index]);
    await this.client.kvBulkDelete(this.#namespaceId, found);
    return found.length;
  }

  /** Deletes the namespace's entries, a listing page at a time. Stamps stay, as on S3. Not atomic, and eventually consistent: a key written elsewhere a moment ago may not be listed yet. */
  async clear(ns: string): Promise<void> {
    this.#assertOpen();
    const prefix = `${this.#nsPath(ns)}/e/`;
    let cursor: string | undefined;
    const keys: string[] = [];
    do {
      const page = await this.client.kvList(this.#namespaceId, prefix, {
        cursor,
      });
      keys.push(...page.keys);
      cursor = page.cursor;
    } while (cursor !== undefined);
    await this.client.kvBulkDelete(this.#namespaceId, keys);
  }

  /* ---------------------------------------------------------------- */
  /* stamps (tags: "stamps", §3.6)                                     */
  /* ---------------------------------------------------------------- */

  async getStamps(
    ns: string,
    tags: readonly string[],
  ): Promise<Map<string, number>> {
    this.#assertOpen();
    const out = new Map<string, number>();
    if (tags.length === 0) {
      return out;
    }
    const texts = await this.client.kvBulkGetText(
      this.#namespaceId,
      tags.map((tag) => this.#stampKey(ns, tag)),
    );
    const now = this.#now();
    tags.forEach((tag, index) => {
      const stamp = parseStamp(texts[index]);
      if (stamp !== undefined && stamp.until > now) {
        out.set(tag, stamp.at);
      }
    });
    return out;
  }

  /**
   * Writes each tag's stamp, moved forward: the stamps are read first (one
   * `bulk/get`) and each written with the later of the two invalidation
   * times and lifetimes (one bulk write). KV has no compare-and-swap, so two
   * invalidations racing from two places can still land out of order; the
   * read narrows that to the requests' own overlap.
   */
  async setStamps(
    ns: string,
    tags: readonly string[],
    at: number,
    until: number,
  ): Promise<void> {
    this.#assertOpen();
    if (tags.length === 0) {
      return;
    }
    const unique = [...new Set(tags)];
    const keys = unique.map((tag) => this.#stampKey(ns, tag));
    const held = await this.client.kvBulkGetText(this.#namespaceId, keys);
    const pairs: KvBulkPair[] = [];
    keys.forEach((key, index) => {
      const old = parseStamp(held[index]);
      const body: StampBody = {
        at: Math.max(at, old?.at ?? at),
        until: Math.max(until, old?.until ?? until),
      };
      if (old !== undefined && old.at === body.at && old.until === body.until) {
        return;
      }
      pairs.push({ key, value: JSON.stringify(body), expiresAt: body.until });
    });
    if (pairs.length > 0) {
      await this.client.kvBulkPut(this.#namespaceId, pairs, this.#now());
    }
  }

  /** There is no schema; nothing to sync (§7.4). */
  syncSchema(_options?: SchemaSyncOptions): Promise<SchemaChange[]> {
    return Promise.resolve([]);
  }
}

/** A Cloudflare KV driver (plan Status, PR-C10): one key per entry, KV's own expiry, stamp-mode tags; no counters, locks or bus. See {@link CloudflareKvDriverOptions}. */
export function cloudflareKvDriver(
  options: CloudflareKvDriverOptions,
): CacheDriver {
  return new CloudflareKvCacheDriver(options);
}
