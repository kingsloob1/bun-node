/**
 * The S3 driver (plan §7.8), over Bun's built-in `S3Client`, with its own
 * SigV4-signed `fetch` for the conditional writes Bun's client cannot send
 * (`s3-sign.ts`).
 *
 * **Layout** (`<p>` is the prefix, `bun-cache` by default; `<ns>` the
 * namespace through `encodeSegment`, so a namespace never adds a `/`):
 *
 * ```
 * <p>/<ns>/e/<hh>/<sha256(key)>   an entry or a counter (the frame says which)
 * <p>/<ns>/s/<sha256(tag)>        a tag stamp, JSON { at, until }
 * <p>/<ns>/l/<sha256(key)>        a lock, JSON { owner, expiresAt }
 * ```
 *
 * `hh` is the first byte of the key's SHA-256, as in the file driver. Every
 * object's `Content-Type` carries its kind and its expiry —
 * `application/x-bun-cache; exp=<ms>; at=<ms>` for an entry,
 * `…-counter`, `…-stamp` and `…-lock` for the others — so the sweeper learns
 * an object's expiry from a `HEAD` instead of a `GET`. (`at`, the write time
 * in ms, orders the caps: a listing's `lastModified` has whole seconds.)
 *
 * - **Reads and plain writes** go through `S3Client`: `get` is one `GET`,
 *   `set` one `PUT`. An entry's body is a frame: the file driver's header
 *   (magic, format, kind, expiry, tags) and the core's bytes.
 * - **Tags** are `stamps` (§3.6): one stamp per invalidated tag, whatever the
 *   number of entries, and the core's read check does the invalidating.
 *   Eager deletion would cost a `LIST` page plus two requests per key. With
 *   conditional writes a stamp only moves forward (a read and a
 *   compare-and-swap), so of two invalidations a moment apart the older never
 *   lands last.
 * - **Counters and locks** need an atomic conditional write, which S3 has
 *   (`If-None-Match: *` and `If-Match: <etag>`; AWS since 2024) and Bun's
 *   client does not send (oven-sh/bun#17339). They are signed here:
 *   `increment` is a compare-and-swap on the counter's object, batched per key
 *   in the process; a lock is created with `If-None-Match: *`, refreshed or
 *   taken over from a lapsed holder with `If-Match`, and released with a
 *   conditional `DELETE`. Before the first of them the driver checks the
 *   store honours the condition (a create-once `PUT` twice must answer 412)
 *   and refuses otherwise; `conditionalWrites: false` turns both off.
 * - **A counter shares its key's object** with an entry, so the last writer
 *   wins for free, as on SQL.
 * - **Expiry** is lazy on read plus the sweeper (`ttl: "sweep"`); a bucket
 *   lifecycle rule on `<p>/` is the operator's backstop. `maxEntries` and
 *   `maxBytes` evict oldest first, by write time — age order, not LRU.
 * - **No bus** (`bus: "none"`, §7.10): give the cache `redisBus` or `pgBus`
 *   for an L1.
 */
import process from "node:process";
import { S3Client } from "bun";
import type { S3Options } from "bun";
import { UnsupportedOperationError } from "../core/errors";
import type {
  CacheDriver,
  CacheDriverCapabilities,
  SchemaChange,
  SchemaSyncOptions,
  StoredEntry,
  TagFence,
} from "../core/types";
import { encodeSegment } from "./file-names";
import type { S3SigningTarget } from "./s3-sign";
import { s3SignedFetch } from "./s3-sign";

/** The default key prefix (§7, §21). */
export const DEFAULT_S3_PREFIX = "bun-cache";

/** The frame's magic, "BS". */
const FRAME_MAGIC = [0x42, 0x53];

/** The frame format's version byte. */
const FRAME_FORMAT = 1;

/** The fixed part of the frame: magic, format, kind, expiresAt f64. */
const FRAME_HEAD = 2 + 1 + 1 + 8;

/** The frame's kind byte for an entry. */
const KIND_ENTRY = 0;

/** The frame's kind byte for a counter. */
const KIND_COUNTER = 1;

/** The sentinel for "no expiry" in the frame's `expiresAt` slot. */
const NO_EXPIRY = -1;

/** The `Content-Type` of each kind of object (§7.8). */
const TYPES = {
  entry: "application/x-bun-cache",
  counter: "application/x-bun-cache-counter",
  stamp: "application/x-bun-cache-stamp",
  lock: "application/x-bun-cache-lock",
} as const;

/** One of the driver's object kinds. */
type ObjectKind = keyof typeof TYPES;

/** How many requests one operation keeps in flight at once (deletes, `HEAD`s, batch writes). */
const CONCURRENCY = 16;

/** The most compare-and-swap attempts one counter batch makes before it fails. */
const MAX_CAS_ATTEMPTS = 100;

/** The most objects the sweeper remembers the expiry of between passes (so an unchanged object is not `HEAD`ed again). */
const SWEEP_MEMO_LIMIT = 100_000;

/** A single `PUT` holds 5 GiB; a MiB is left for the frame's header. */
const MAX_ENTRY_BYTES = 5 * 1024 * 1024 * 1024 - 1024 * 1024;

/** `s3Driver()`'s options: where the bucket is (a URL, Bun's `S3Options`, or a client), and the driver's own. */
export interface S3DriverOptions {
  /**
   * `s3://<accessKeyId>:<secretAccessKey>@<host>[:<port>]/<bucket>`, with
   * optional `?region=<region>` and `?scheme=http` (the default is `https`;
   * `http` is for a local test server). The key and secret are
   * percent-decoded, so a secret holding `/` or `+` is written `%2F`, `%2B`.
   * Wins over the same fields of `connection`.
   */
  url?: string;
  /**
   * Bun's own `S3Options` (`accessKeyId`, `secretAccessKey`, `sessionToken`,
   * `region`, `endpoint`, `bucket`, `virtualHostedStyle`, `retry`, …), passed
   * to the `S3Client` the driver builds. A field it leaves out is read from
   * the environment the way Bun reads it (`S3_*`, then `AWS_*`), by the
   * client and by the driver's own signed requests alike.
   */
  connection?: S3Options;
  /**
   * An existing `S3Client` for the reads and plain writes. Bun's client does
   * not expose its credentials, so the conditional requests (counters, locks)
   * sign with `url`/`connection` (and the environment); with none of them
   * resolving to a bucket and a key, `conditionalWrites` defaults to `false`.
   * Nothing to close either way.
   */
  client?: S3Client;
  /**
   * Prepended to every object key (`<prefix>/<ns>/…`). Defaults to
   * `bun-cache`. Must not be empty or start with `/`; a trailing `/` is
   * dropped. The sweeper walks everything under it, so give each cache's
   * objects a prefix of their own.
   */
  prefix?: string;
  /**
   * At most this many entries; the oldest by write time go first, enforced by
   * the sweeper (so the bucket can briefly exceed it between sweeps).
   * Counters are never counted or evicted. Uncapped by default.
   */
  maxEntries?: number;
  /** At most this many bytes of entries (the objects' sizes); the oldest go first, as `maxEntries`. Uncapped by default. */
  maxBytes?: number;
  /**
   * Whether counters and locks run on conditional writes (`If-None-Match`,
   * `If-Match`), which the store must honour. Defaults to `true` (`false`
   * with a `client` and no credentials). Before the first counter or lock
   * operation the driver checks the store answers a repeated create-once
   * `PUT` with 412, and throws otherwise. `false`: `increment`, `acquireLock`
   * and `releaseLock` are unsupported (`atomicIncrement` and `lock` are
   * `false`), so `getOrSet` loads without a cross-process lock.
   */
  conditionalWrites?: boolean;
  /** The clock, epoch ms. Internal: for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** What one object's `Content-Type` (or, failing it, its frame) says. */
interface ObjectInfo {
  /** Its kind; `undefined` when the type is not one of the driver's. */
  kind: ObjectKind | undefined;
  /** Its expiry, epoch ms; `null` for none. */
  expiresAt: number | null;
  /** When it was written, epoch ms, when the type says. */
  at: number | undefined;
}

/** A stamp object's body. */
interface StampBody {
  /** When the tag was invalidated, epoch ms. */
  at: number;
  /** When the stamp itself lapses, epoch ms. */
  until: number;
}

/** A lock object's body. */
interface LockBody {
  /** Who holds it. */
  owner: string;
  /** When it lapses, epoch ms. */
  expiresAt: number;
}

/** A decoded frame: an entry or a counter. */
type Frame =
  | {
      /** An entry. */
      kind: "entry";
      /** Its expiry; `null` for none. */
      expiresAt: number | null;
      /** Its tags. */
      tags: string[];
      /** The core's bytes. */
      value: Uint8Array;
    }
  | {
      /** A counter. */
      kind: "counter";
      /** Its expiry; `null` for none. */
      expiresAt: number | null;
      /** Its value. */
      value: number;
      /** When it was created, epoch ms. */
      createdAt: number;
    };

/** One queued `increment` call, waiting for its key's batch. */
interface PendingIncrement {
  /** What to add. */
  by: number;
  /** The expiry the counter gets if this call creates it. */
  expiresAt: number | null;
  /** Answers the call with its own value. */
  resolve: (value: number) => void;
  /** Fails the call. */
  reject: (error: unknown) => void;
}

/** One entry the sweeper may evict for the caps. */
interface CapCandidate {
  /** The object key. */
  key: string;
  /** Its size, bytes. */
  size: number;
  /** When it was written, epoch ms. */
  at: number;
  /** Its ETag, for the conditional delete. */
  etag: string;
}

/** What the sweeper remembers of an object between passes. */
interface MemoEntry {
  /** The ETag it had when it was read. */
  etag: string;
  /** Its `lastModified`, ms. */
  lastModified: number;
  /** What its type said. */
  info: ObjectInfo;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Hashes a name (a key or a tag) for its object name. */
function hash(name: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(name);
  return hasher.digest("hex");
}

/**
 * A namespace as one key segment: `encodeSegment`, plus an escape for a
 * segment of dots only, which a URL would resolve as `.`/`..` (encodeSegment
 * never writes a bare `~`, so the escape is unambiguous).
 */
function segment(ns: string): string {
  const encoded = encodeSegment(ns);
  if (/^\.*$/.test(encoded)) {
    return encoded === "" ? "~" : "~2e".repeat(encoded.length);
  }
  return encoded;
}

/** An object's `Content-Type`: its kind, its expiry and its write time. */
function contentType(
  kind: ObjectKind,
  expiresAt: number | null,
  at: number,
): string {
  const exp = expiresAt === null ? "" : `; exp=${Math.ceil(expiresAt)}`;
  return `${TYPES[kind]}${exp}; at=${Math.floor(at)}`;
}

/** Reads a `Content-Type` the driver wrote; `kind: undefined` for any other. */
export function parseContentType(type: string | undefined | null): ObjectInfo {
  const [media = "", ...params] = (type ?? "").split(";");
  const name = media.trim().toLowerCase();
  const kind = (Object.keys(TYPES) as ObjectKind[]).find(
    (each) => TYPES[each] === name,
  );
  let expiresAt: number | null = null;
  let at: number | undefined;
  for (const param of params) {
    const [key, value] = param.split("=").map((part) => part.trim());
    const number = Number(value);
    if (value === undefined || value === "" || !Number.isFinite(number)) {
      continue;
    }
    if (key === "exp") {
      expiresAt = number;
    } else if (key === "at") {
      at = number;
    }
  }
  return { kind, expiresAt, at };
}

/** Encodes an entry's frame. */
function encodeEntry(entry: StoredEntry): Uint8Array {
  const tags = entry.tags.map((tag) => ENCODER.encode(tag));
  const tagsLength = tags.reduce((total, tag) => total + 2 + tag.length, 0);
  const out = new Uint8Array(FRAME_HEAD + 2 + tagsLength + entry.value.length);
  const view = new DataView(out.buffer);
  writeHead(out, view, KIND_ENTRY, entry.expiresAt);
  view.setUint16(FRAME_HEAD, tags.length, true);
  let offset = FRAME_HEAD + 2;
  for (const tag of tags) {
    view.setUint16(offset, tag.length, true);
    out.set(tag, offset + 2);
    offset += 2 + tag.length;
  }
  out.set(entry.value, offset);
  return out;
}

/** Encodes a counter's frame. */
function encodeCounter(
  value: number,
  expiresAt: number | null,
  createdAt: number,
): Uint8Array {
  const out = new Uint8Array(FRAME_HEAD + 16);
  const view = new DataView(out.buffer);
  writeHead(out, view, KIND_COUNTER, expiresAt);
  view.setFloat64(FRAME_HEAD, value, true);
  view.setFloat64(FRAME_HEAD + 8, createdAt, true);
  return out;
}

/** Writes the frame's fixed head. */
function writeHead(
  out: Uint8Array,
  view: DataView,
  kind: number,
  expiresAt: number | null,
): void {
  out[0] = FRAME_MAGIC[0];
  out[1] = FRAME_MAGIC[1];
  out[2] = FRAME_FORMAT;
  out[3] = kind;
  view.setFloat64(4, expiresAt ?? NO_EXPIRY, true);
}

/** Decodes a frame's fixed head; `undefined` when the bytes are not a frame. */
function decodeHead(
  bytes: Uint8Array,
): { kind: number; expiresAt: number | null } | undefined {
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
  return {
    kind: bytes[3],
    expiresAt: expiresAt === NO_EXPIRY ? null : expiresAt,
  };
}

/** Decodes a whole frame; `undefined` when the bytes are not one. */
function decodeFrame(bytes: Uint8Array): Frame | undefined {
  const head = decodeHead(bytes);
  if (head === undefined) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (head.kind === KIND_COUNTER) {
    if (bytes.length < FRAME_HEAD + 16) {
      return undefined;
    }
    return {
      kind: "counter",
      expiresAt: head.expiresAt,
      value: view.getFloat64(FRAME_HEAD, true),
      createdAt: view.getFloat64(FRAME_HEAD + 8, true),
    };
  }
  if (head.kind !== KIND_ENTRY || bytes.length < FRAME_HEAD + 2) {
    return undefined;
  }
  const count = view.getUint16(FRAME_HEAD, true);
  let offset = FRAME_HEAD + 2;
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
    kind: "entry",
    expiresAt: head.expiresAt,
    tags,
    value: bytes.slice(offset),
  };
}

/** Whether `error` is S3's answer for a missing object. */
function isNoSuchKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "NoSuchKey"
  );
}

/** The S3 error code in a failed response's XML body, if any. */
async function errorCode(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? "";
}

/** Whether a conditional request lost its race: 412, or AWS's 409 `ConditionalRequestConflict`. */
function isConflict(status: number): boolean {
  return status === 412 || status === 409;
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

/** Waits a jittered, growing backoff after a lost compare-and-swap. */
async function backoff(attempt: number): Promise<void> {
  await Bun.sleep(Math.min(2 * 1.5 ** attempt, 100) * (0.5 + Math.random()));
}

/** The environment variable Bun reads for an `S3Options` field: `S3_*`, then `AWS_*`. */
function fromEnv(name: string): string | undefined {
  return process.env[`S3_${name}`] || process.env[`AWS_${name}`] || undefined;
}

/**
 * Reads the driver's `s3://` URL into Bun's `S3Options`. Throws a `TypeError`
 * naming what is wrong.
 */
export function parseS3Url(url: string): S3Options {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("s3Driver: url is not a URL");
  }
  if (parsed.protocol !== "s3:") {
    throw new TypeError(
      `s3Driver: url must start with s3://, not ${parsed.protocol}//`,
    );
  }
  const bucket = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/g, ""));
  if (parsed.host === "" || bucket === "" || bucket.includes("/")) {
    throw new TypeError(
      "s3Driver: url must be s3://<accessKeyId>:<secretAccessKey>@<host>[:<port>]/<bucket>",
    );
  }
  const scheme = parsed.searchParams.get("scheme") ?? "https";
  if (scheme !== "https" && scheme !== "http") {
    throw new TypeError(
      `s3Driver: the url's scheme parameter must be https or http, not ${scheme}`,
    );
  }
  const out: S3Options = { endpoint: `${scheme}://${parsed.host}`, bucket };
  if (parsed.username !== "") {
    out.accessKeyId = decodeURIComponent(parsed.username);
  }
  if (parsed.password !== "") {
    out.secretAccessKey = decodeURIComponent(parsed.password);
  }
  const region = parsed.searchParams.get("region");
  if (region !== null && region !== "") {
    out.region = region;
  }
  return out;
}

/**
 * The bucket, endpoint and credentials the signed requests use: the given
 * options, then the environment, the way Bun's client resolves them —
 * including its region rule (a custom endpoint is `auto`; an AWS endpoint
 * names its region; no endpoint is `us-east-1` on `s3.us-east-1.amazonaws.com`,
 * measured with `presign()`). `undefined` when no bucket or key resolves.
 */
export function resolveSigningTarget(
  options: S3Options,
): S3SigningTarget | undefined {
  const accessKeyId = options.accessKeyId || fromEnv("ACCESS_KEY_ID");
  const secretAccessKey =
    options.secretAccessKey || fromEnv("SECRET_ACCESS_KEY");
  const bucket = options.bucket || fromEnv("BUCKET");
  if (!accessKeyId || !secretAccessKey || !bucket) {
    return undefined;
  }
  const given = options.endpoint || fromEnv("ENDPOINT");
  const awsRegion =
    given === undefined
      ? undefined
      : /(?:^|\/\/|\.)s3[.-]([a-z0-9-]+)\.amazonaws\.com/.exec(given)?.[1];
  const region =
    options.region ||
    fromEnv("REGION") ||
    awsRegion ||
    (given === undefined ? "us-east-1" : "auto");
  const endpoint = (given ?? `https://s3.${region}.amazonaws.com`).replace(
    /\/+$/,
    "",
  );
  return {
    endpoint: /^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken: options.sessionToken || fromEnv("SESSION_TOKEN"),
    virtualHostedStyle: options.virtualHostedStyle === true,
  };
}

/** Thrown when the store overwrites through `If-None-Match: *`: its conditional writes cannot be trusted. */
class ConditionalWritesIgnoredError extends Error {
  constructor(/** The store's endpoint, for the message. */ endpoint: string) {
    super(
      `s3Driver: the store at ${endpoint} does not honour conditional writes (a second If-None-Match: * PUT overwrote the first instead of answering 412), so counters and locks cannot be atomic there. Set conditionalWrites: false to run without them.`,
    );
    this.name = "ConditionalWritesIgnoredError";
  }
}

/** The S3 driver. See the module header and {@link S3DriverOptions}. */
export class S3CacheDriver implements CacheDriver {
  /** `"s3"`. */
  readonly name = "s3";

  /** Lazy expiry plus the sweeper, stamp-mode tags, no bus; counters and locks only with conditional writes (§7.10). */
  readonly capabilities: CacheDriverCapabilities;

  /** The key prefix, as resolved. Internal; read by the tests. */
  readonly prefix: string;

  /** The client the reads and plain writes run on. */
  readonly #client: S3Client;

  /** Where the signed (conditional) requests go; `undefined` without credentials. */
  readonly #target: S3SigningTarget | undefined;

  /** Whether counters and locks are on. */
  readonly #conditionalWrites: boolean;

  /** The `maxEntries` cap; `undefined` for none. */
  readonly #maxEntries: number | undefined;

  /** The `maxBytes` cap; `undefined` for none. */
  readonly #maxBytes: number | undefined;

  /** The clock. */
  readonly #now: () => number;

  /** The connect check (one listing), shared; cleared when it fails. */
  #connected: Promise<void> | undefined;

  /** The conditional-write check, shared once it passed or proved the store ignores the condition; cleared on a transient failure. */
  #conditionalChecked: Promise<void> | undefined;

  /** Each key's queued increments, by object key, while a batch is running. */
  readonly #counterQueues = new Map<string, PendingIncrement[]>();

  /** The last lock call queued on each lock object in this process (see `#serially`). */
  readonly #lockChains = new Map<string, Promise<void>>();

  /** What the sweeper read of each object on its last pass. */
  #sweepMemo = new Map<string, MemoEntry>();

  /** Set once `close()` ran. */
  #closed = false;

  constructor(
    /** The options: a URL, Bun's `S3Options` or a client, and the driver's own. */ options: S3DriverOptions,
  ) {
    const prefix = (options.prefix ?? DEFAULT_S3_PREFIX).replace(/\/+$/, "");
    if (prefix === "" || prefix.startsWith("/")) {
      throw new TypeError(
        `s3Driver: prefix must not be empty or start with /; got ${JSON.stringify(options.prefix)}`,
      );
    }
    this.prefix = prefix;
    for (const cap of ["maxEntries", "maxBytes"] as const) {
      const value = options[cap];
      if (value !== undefined && !(Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError(
          `s3Driver: ${cap} must be a positive whole number; got ${String(value)}`,
        );
      }
    }
    this.#maxEntries = options.maxEntries;
    this.#maxBytes = options.maxBytes;
    this.#now = options.now ?? Date.now;

    const given =
      options.url === undefined && options.connection === undefined
        ? undefined
        : {
            ...options.connection,
            ...(options.url === undefined ? {} : parseS3Url(options.url)),
          };
    if (given === undefined && options.client === undefined) {
      throw new TypeError(
        "s3Driver needs a url, a connection (Bun's S3Options) or a client",
      );
    }
    this.#client = options.client ?? new S3Client(given);
    this.#target = resolveSigningTarget(given ?? {});
    if (options.conditionalWrites === true && this.#target === undefined) {
      throw new TypeError(
        "s3Driver: conditionalWrites needs credentials and a bucket for its signed requests (url, connection or the S3_*/AWS_* environment); a client alone does not expose them",
      );
    }
    this.#conditionalWrites =
      options.conditionalWrites ?? this.#target !== undefined;
    this.capabilities = {
      multiProcess: true,
      ttl: "sweep",
      atomicIncrement: this.#conditionalWrites,
      lock: this.#conditionalWrites,
      tags: "stamps",
      fence: "atomic",
      bus: "none",
      maxEntryBytes: MAX_ENTRY_BYTES,
    };
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Checks the bucket answers (one listing of one key under the prefix).
   * Idempotent; nothing else waits for it — S3 has no connection to open.
   */
  async connect(): Promise<void> {
    this.#assertOpen();
    this.#connected ??= this.ping().catch((error: unknown) => {
      this.#connected = undefined;
      throw error;
    });
    await this.#connected;
  }

  /** Nothing to close: `fetch` and Bun's client hold no connection the driver owns. Further operations throw. */
  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }

  /** One listing of at most one key. */
  async ping(): Promise<void> {
    await this.#client.list({ prefix: `${this.prefix}/`, maxKeys: 1 });
  }

  /** Throws once the driver is closed. */
  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("the s3 cache driver is closed");
    }
  }

  /* ---------------------------------------------------------------- */
  /* paths                                                             */
  /* ---------------------------------------------------------------- */

  /** The namespace's key prefix. */
  #nsPath(ns: string): string {
    return `${this.prefix}/${segment(ns)}`;
  }

  /** The object of an entry or counter. */
  #entryPath(ns: string, key: string): string {
    const hashed = hash(key);
    return `${this.#nsPath(ns)}/e/${hashed.slice(0, 2)}/${hashed}`;
  }

  /** The object of a tag's stamp. */
  #stampPath(ns: string, tag: string): string {
    return `${this.#nsPath(ns)}/s/${hash(tag)}`;
  }

  /** The object of a lock. */
  #lockPath(ns: string, key: string): string {
    return `${this.#nsPath(ns)}/l/${hash(key)}`;
  }

  /* ---------------------------------------------------------------- */
  /* small S3 pieces                                                   */
  /* ---------------------------------------------------------------- */

  /** An object's bytes through the client; `undefined` when it does not exist. */
  async #read(path: string): Promise<Uint8Array | undefined> {
    try {
      return await this.#client.file(path).bytes();
    } catch (error) {
      if (isNoSuchKey(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /** The signing target, or the refusal of an operation that needs one. */
  #signing(op: string): S3SigningTarget {
    if (!this.#conditionalWrites || this.#target === undefined) {
      throw new UnsupportedOperationError(
        this.name,
        op,
        "conditional writes are off (conditionalWrites: false, or a client with no credentials)",
      );
    }
    return this.#target;
  }

  /** A signed `GET`: the object's bytes and ETag, or `undefined` when it does not exist. */
  async #readTagged(
    target: S3SigningTarget,
    path: string,
  ): Promise<{ bytes: Uint8Array; etag: string } | undefined> {
    const response = await s3SignedFetch(target, { method: "GET", key: path });
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      throw new Error(
        `s3Driver: GET ${path} answered ${response.status} ${await errorCode(response)}`,
      );
    }
    const etag = response.headers.get("etag");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (etag === null) {
      throw new Error(`s3Driver: GET ${path} answered no ETag`);
    }
    return { bytes, etag };
  }

  /**
   * A conditional `PUT`: `ifMatch` an ETag, or `"*"` for create-only
   * (`If-None-Match: *`). Answers `true` when written, `false` when the
   * condition failed (412, or AWS's 409 for a concurrent conditional write).
   */
  async #putIf(
    target: S3SigningTarget,
    path: string,
    body: Uint8Array | string,
    type: string,
    condition: { ifMatch: string } | { ifNoneMatch: "*" },
  ): Promise<boolean> {
    const headers: Record<string, string> = { "content-type": type };
    if ("ifMatch" in condition) {
      headers["if-match"] = condition.ifMatch;
    } else {
      headers["if-none-match"] = "*";
    }
    const response = await s3SignedFetch(target, {
      method: "PUT",
      key: path,
      headers,
      body,
    });
    if (response.ok) {
      await response.body?.cancel();
      return true;
    }
    if (isConflict(response.status)) {
      await response.body?.cancel();
      return false;
    }
    throw new Error(
      `s3Driver: conditional PUT ${path} answered ${response.status} ${await errorCode(response)}`,
    );
  }

  /** A `DELETE` only while the object still has `etag`; answers whether it went. */
  async #deleteIf(
    target: S3SigningTarget,
    path: string,
    etag: string,
  ): Promise<boolean> {
    const response = await s3SignedFetch(target, {
      method: "DELETE",
      key: path,
      headers: { "if-match": etag },
    });
    await response.body?.cancel();
    if (response.ok) {
      return true;
    }
    if (isConflict(response.status) || response.status === 404) {
      return false;
    }
    throw new Error(
      `s3Driver: conditional DELETE ${path} answered ${response.status}`,
    );
  }

  /** Deletes an object the sweeper judged, only if unchanged since (when conditional writes are on). */
  async #sweepDelete(path: string, etag: string): Promise<void> {
    if (this.#conditionalWrites && this.#target !== undefined) {
      await this.#deleteIf(this.#target, path, etag);
    } else {
      await this.#client.delete(path);
    }
  }

  /**
   * Checks, once, that the store honours a conditional write: a create-once
   * `PUT` repeated must answer 412. A store that overwrites instead would let
   * two processes both "win" a lock or lose increments, so the driver refuses
   * to run counters or locks on it. A transient failure is retried next time.
   */
  async #checkConditional(op: string): Promise<S3SigningTarget> {
    const target = this.#signing(op);
    this.#conditionalChecked ??= (async () => {
      const probe = `${this.prefix}/Probe/${process.pid}-${crypto.randomUUID()}`;
      try {
        const first = await this.#putIf(target, probe, "1", TYPES.lock, {
          ifNoneMatch: "*",
        });
        const second = await this.#putIf(target, probe, "2", TYPES.lock, {
          ifNoneMatch: "*",
        });
        if (!first || second) {
          throw new ConditionalWritesIgnoredError(target.endpoint);
        }
      } finally {
        await this.#client.delete(probe).catch(() => undefined);
      }
    })().catch((error: unknown) => {
      if (!(error instanceof ConditionalWritesIgnoredError)) {
        this.#conditionalChecked = undefined;
      }
      throw error;
    });
    await this.#conditionalChecked;
    return target;
  }

  /* ---------------------------------------------------------------- */
  /* entries                                                           */
  /* ---------------------------------------------------------------- */

  async get(ns: string, key: string): Promise<StoredEntry | undefined> {
    this.#assertOpen();
    const path = this.#entryPath(ns, key);
    const bytes = await this.#read(path);
    if (bytes === undefined) {
      return undefined;
    }
    const frame = decodeFrame(bytes);
    if (frame === undefined || frame.kind !== "entry") {
      return undefined;
    }
    if (frame.expiresAt !== null && frame.expiresAt <= this.#now()) {
      // Lazy expiry: reclaimed in the background (§7.8). A write that lands
      // between this read and the delete is lost with it: one extra miss.
      void this.#client.delete(path).catch(() => undefined);
      return undefined;
    }
    return {
      key,
      value: frame.value,
      expiresAt: frame.expiresAt,
      tags: frame.tags,
    };
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
    await this.#client.write(
      this.#entryPath(ns, entry.key),
      encodeEntry(entry),
      {
        type: contentType("entry", entry.expiresAt, this.#now()),
      },
    );
    return "stored";
  }

  async setMany(ns: string, entries: readonly StoredEntry[]): Promise<void> {
    await mapLimit(
      entries,
      CONCURRENCY,
      async (entry) => await this.set(ns, entry),
    );
  }

  /** Deletes entries and counters; a `HEAD` per key first, because S3 answers a `DELETE` the same whether or not the object was there. */
  async delete(ns: string, keys: readonly string[]): Promise<number> {
    this.#assertOpen();
    const removed = await mapLimit(keys, CONCURRENCY, async (key) => {
      const path = this.#entryPath(ns, key);
      if (!(await this.#client.exists(path))) {
        return 0;
      }
      await this.#client.delete(path);
      return 1;
    });
    return removed.reduce<number>((total, each) => total + each, 0);
  }

  /** Deletes the namespace's entries and counters, page by page. Stamps and locks stay, as on SQL and Redis. Not atomic. */
  async clear(ns: string): Promise<void> {
    this.#assertOpen();
    const prefix = `${this.#nsPath(ns)}/e/`;
    for (;;) {
      const page = await this.#client.list({ prefix, maxKeys: 1000 });
      const keys = (page.contents ?? []).map((object) => object.key);
      if (keys.length === 0) {
        return;
      }
      await mapLimit(keys, CONCURRENCY, async (key) => {
        await this.#client.delete(key);
      });
    }
  }

  /**
   * Rewrites an entry's (or counter's) expiry: S3 cannot change an object in
   * place, so it is a read and a rewrite — a compare-and-swap with conditional
   * writes on, so a `set` landing in between is never overwritten by the old
   * value; a plain rewrite without them.
   */
  async touch(
    ns: string,
    key: string,
    expiresAt: number | null,
  ): Promise<boolean> {
    this.#assertOpen();
    const path = this.#entryPath(ns, key);
    const target =
      this.#conditionalWrites && this.#target !== undefined
        ? await this.#checkConditional("touch")
        : undefined;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const read =
        target === undefined
          ? await this.#read(path).then((bytes) =>
              bytes === undefined ? undefined : { bytes, etag: "" },
            )
          : await this.#readTagged(target, path);
      const frame = read === undefined ? undefined : decodeFrame(read.bytes);
      if (read === undefined || frame === undefined) {
        return false;
      }
      const now = this.#now();
      if (frame.expiresAt !== null && frame.expiresAt <= now) {
        return false;
      }
      const body =
        frame.kind === "entry"
          ? encodeEntry({
              key,
              value: frame.value,
              tags: frame.tags,
              expiresAt,
            })
          : encodeCounter(frame.value, expiresAt, frame.createdAt);
      const type = contentType(frame.kind, expiresAt, now);
      if (target === undefined) {
        await this.#client.write(path, body, { type });
        return true;
      }
      if (await this.#putIf(target, path, body, type, { ifMatch: read.etag })) {
        return true;
      }
      await backoff(attempt);
    }
    throw new Error(
      `s3Driver: touch ${path} lost ${MAX_CAS_ATTEMPTS} races in a row`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* stamps (tags: "stamps", §3.6)                                     */
  /* ---------------------------------------------------------------- */

  async getStamps(
    ns: string,
    tags: readonly string[],
  ): Promise<Map<string, number>> {
    this.#assertOpen();
    const now = this.#now();
    const read = await mapLimit(tags, CONCURRENCY, async (tag) => {
      const bytes = await this.#read(this.#stampPath(ns, tag));
      if (bytes === undefined) {
        return undefined;
      }
      try {
        const stamp = JSON.parse(DECODER.decode(bytes)) as StampBody;
        return stamp.until > now ? stamp.at : undefined;
      } catch {
        return undefined;
      }
    });
    const out = new Map<string, number>();
    tags.forEach((tag, index) => {
      const at = read[index];
      if (at !== undefined) {
        out.set(tag, at);
      }
    });
    return out;
  }

  /**
   * Writes each tag's stamp. With conditional writes on, a stamp only ever
   * moves forward: it is read with its ETag and replaced (`If-Match`, or
   * created with `If-None-Match: *`) by the later of the two invalidation
   * times and lifetimes. A plain `PUT` is last-writer-wins, so of two
   * invalidations of one tag a moment apart the older could land last and an
   * entry loaded between them would pass the read check. Without conditional
   * writes, a plain `PUT` (as the file driver's rename).
   */
  async setStamps(
    ns: string,
    tags: readonly string[],
    at: number,
    until: number,
  ): Promise<void> {
    this.#assertOpen();
    const target =
      this.#conditionalWrites && this.#target !== undefined
        ? await this.#checkConditional("setStamps")
        : undefined;
    await mapLimit(tags, CONCURRENCY, async (tag) => {
      const path = this.#stampPath(ns, tag);
      if (target === undefined) {
        const body: StampBody = { at, until };
        await this.#client.write(path, JSON.stringify(body), {
          type: contentType("stamp", until, this.#now()),
        });
        return;
      }
      await this.#advanceStamp(target, path, at, until);
    });
  }

  /** Moves one stamp forward to `at`/`until` with a compare-and-swap; a stamp already as late is left alone. */
  async #advanceStamp(
    target: S3SigningTarget,
    path: string,
    at: number,
    until: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const read = await this.#readTagged(target, path);
      let held: StampBody | undefined;
      if (read !== undefined) {
        try {
          held = JSON.parse(DECODER.decode(read.bytes)) as StampBody;
        } catch {
          // Not a stamp this driver wrote: replace it.
        }
      }
      const body: StampBody = {
        at: Math.max(at, held?.at ?? at),
        until: Math.max(until, held?.until ?? until),
      };
      if (
        held !== undefined &&
        held.at === body.at &&
        held.until === body.until
      ) {
        return;
      }
      const written = await this.#putIf(
        target,
        path,
        JSON.stringify(body),
        contentType("stamp", body.until, this.#now()),
        read === undefined ? { ifNoneMatch: "*" } : { ifMatch: read.etag },
      );
      if (written) {
        return;
      }
      await backoff(attempt);
    }
    throw new Error(
      `s3Driver: stamp ${path} lost ${MAX_CAS_ATTEMPTS} races in a row`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* counters (§3.8: compare-and-swap, batched per key)                */
  /* ---------------------------------------------------------------- */

  /**
   * Adds `by` atomically. Concurrent calls on one key in this process join one
   * queue: each batch is one compare-and-swap adding the batch's sum, and each
   * call gets its own value in order — so 200 callers cost a handful of
   * writes, not 200 contenders retrying on one object.
   */
  async increment(
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ): Promise<number> {
    this.#assertOpen();
    const target = await this.#checkConditional("increment");
    const path = this.#entryPath(ns, key);
    return await new Promise<number>((resolve, reject) => {
      let queue = this.#counterQueues.get(path);
      const fresh = queue === undefined;
      if (queue === undefined) {
        queue = [];
        this.#counterQueues.set(path, queue);
      }
      queue.push({ by, expiresAt, resolve, reject });
      if (fresh) {
        void this.#drainCounter(target, path, queue);
      }
    });
  }

  /** Runs a key's queued increments, a batch at a time, until none are left. */
  async #drainCounter(
    target: S3SigningTarget,
    path: string,
    queue: PendingIncrement[],
  ): Promise<void> {
    try {
      // Let the callers of this tick join the first batch.
      await Promise.resolve();
      while (queue.length > 0) {
        const batch = queue.splice(0);
        try {
          let value = await this.#addToCounter(target, path, batch);
          for (const call of batch) {
            value += call.by;
            call.resolve(value);
          }
        } catch (error) {
          for (const call of batch) {
            call.reject(error);
          }
        }
      }
    } finally {
      this.#counterQueues.delete(path);
    }
  }

  /**
   * One batch's compare-and-swap: reads the counter and its ETag, writes the
   * sum with `If-Match` (or creates it with `If-None-Match: *`), and retries
   * on a lost race. Answers the value before the batch. A key holding an entry
   * or a lapsed counter starts again from zero, with the first call's expiry.
   */
  async #addToCounter(
    target: S3SigningTarget,
    path: string,
    batch: readonly PendingIncrement[],
  ): Promise<number> {
    const sum = batch.reduce((total, call) => total + call.by, 0);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const now = this.#now();
      const read = await this.#readTagged(target, path);
      const frame = read === undefined ? undefined : decodeFrame(read.bytes);
      const live =
        frame?.kind === "counter" &&
        (frame.expiresAt === null || frame.expiresAt > now)
          ? frame
          : undefined;
      const base = live?.value ?? 0;
      const expiresAt =
        live === undefined ? batch[0].expiresAt : live.expiresAt;
      const body = encodeCounter(base + sum, expiresAt, live?.createdAt ?? now);
      const written = await this.#putIf(
        target,
        path,
        body,
        contentType("counter", expiresAt, now),
        read === undefined ? { ifNoneMatch: "*" } : { ifMatch: read.etag },
      );
      if (written) {
        return base;
      }
      await backoff(attempt);
    }
    throw new Error(
      `s3Driver: increment ${path} lost ${MAX_CAS_ATTEMPTS} races in a row`,
    );
  }

  async getCounter(
    ns: string,
    key: string,
  ): Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  > {
    this.#assertOpen();
    const bytes = await this.#read(this.#entryPath(ns, key));
    const frame = bytes === undefined ? undefined : decodeFrame(bytes);
    if (frame?.kind !== "counter") {
      return undefined;
    }
    if (frame.expiresAt !== null && frame.expiresAt <= this.#now()) {
      return undefined;
    }
    return {
      value: frame.value,
      expiresAt: frame.expiresAt,
      createdAt: frame.createdAt,
    };
  }

  /* ---------------------------------------------------------------- */
  /* locks (conditional PUTs)                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Runs `run` after every earlier lock call on the same object in this
   * process. Measured on SeaweedFS 4.48: concurrent conditional writes to one
   * object are serialised by the server, each loser answering 412 only after
   * waiting about a second more than the one before (50 contenders: 10 s),
   * while one at a time they answer in a millisecond. In one process the
   * contenders therefore queue here instead, and on AWS that also saves the
   * failed conditional requests, which are billed.
   */
  async #serially<T>(path: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#lockChains.get(path) ?? Promise.resolve();
    let done!: () => void;
    const turn = new Promise<void>((resolve) => {
      done = resolve;
    });
    const mine = previous.then(async () => await turn);
    this.#lockChains.set(path, mine);
    try {
      await previous;
      return await run();
    } finally {
      done();
      if (this.#lockChains.get(path) === mine) {
        this.#lockChains.delete(path);
      }
    }
  }

  /**
   * Reads the lock first: a live lock held by another owner is refused with
   * that one `GET` and no write. Absent, it is created with
   * `If-None-Match: *`; held by `owner` already, re-taken (its expiry
   * refreshed); positively lapsed, taken over — both with `If-Match` on the
   * ETag just read, so of two processes judging the same lapsed lock only
   * one wins. A lock created by someone else between the read and the create
   * is read again, a bounded number of times.
   */
  async acquireLock(
    ns: string,
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    this.#assertOpen();
    const target = await this.#checkConditional("acquireLock");
    const path = this.#lockPath(ns, key);
    return await this.#serially(path, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const now = this.#now();
        const lock: LockBody = { owner, expiresAt: now + ttlMs };
        const body = JSON.stringify(lock);
        const type = contentType("lock", lock.expiresAt, now);
        const read = await this.#readTagged(target, path);
        if (read === undefined) {
          if (
            await this.#putIf(target, path, body, type, { ifNoneMatch: "*" })
          ) {
            return true;
          }
          continue;
        }
        let held: LockBody | undefined;
        try {
          held = JSON.parse(DECODER.decode(read.bytes)) as LockBody;
        } catch {
          // Not a lock this driver wrote: nothing holds it.
        }
        const takeable =
          held === undefined ||
          typeof held.expiresAt !== "number" ||
          held.owner === owner ||
          held.expiresAt <= now;
        if (!takeable) {
          return false;
        }
        return await this.#putIf(target, path, body, type, {
          ifMatch: read.etag,
        });
      }
      return false;
    });
  }

  /** Compare-and-delete: reads the lock and deletes it with `If-Match` only while `owner` holds it. */
  async releaseLock(ns: string, key: string, owner: string): Promise<boolean> {
    this.#assertOpen();
    const target = await this.#checkConditional("releaseLock");
    const path = this.#lockPath(ns, key);
    return await this.#serially(path, async () => {
      const read = await this.#readTagged(target, path);
      if (read === undefined) {
        return false;
      }
      try {
        const held = JSON.parse(DECODER.decode(read.bytes)) as LockBody;
        if (held.owner !== owner) {
          return false;
        }
      } catch {
        return false;
      }
      return await this.#deleteIf(target, path, read.etag);
    });
  }

  /* ---------------------------------------------------------------- */
  /* the sweeper                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * What an object is and when it expires: from the sweeper's memo when the
   * listing shows it unchanged, else its `Content-Type` (one `HEAD`), else —
   * for a store that keeps no type parameters — its frame's head (a ranged
   * `GET` of 12 bytes; entries and counters only).
   */
  async #inspect(
    object: { key: string; eTag?: string; lastModified?: string },
    memo: Map<string, MemoEntry>,
  ): Promise<ObjectInfo & { etag: string; lastModified: number }> {
    const lastModified = Date.parse(object.lastModified ?? "") || 0;
    const known = this.#sweepMemo.get(object.key);
    if (
      known !== undefined &&
      object.eTag !== undefined &&
      known.etag === object.eTag &&
      known.lastModified === lastModified
    ) {
      if (memo.size < SWEEP_MEMO_LIMIT) {
        memo.set(object.key, known);
      }
      return { ...known.info, etag: known.etag, lastModified };
    }
    const stat = await this.#client.stat(object.key);
    let info = parseContentType(stat.type);
    if (info.kind === undefined && object.key.includes("/e/")) {
      const head = decodeHead(
        await this.#client.file(object.key).slice(0, FRAME_HEAD).bytes(),
      );
      if (head !== undefined) {
        info = {
          kind: head.kind === KIND_COUNTER ? "counter" : "entry",
          expiresAt: head.expiresAt,
          at: undefined,
        };
      }
    }
    const etag = stat.etag || object.eTag || "";
    if (memo.size < SWEEP_MEMO_LIMIT) {
      memo.set(object.key, { etag, lastModified, info });
    }
    return { ...info, etag, lastModified };
  }

  /**
   * Walks every object under the prefix: deletes the expired ones (entries,
   * counters, stamps, locks; at most `limit`, each only if unchanged since it
   * was judged, with conditional writes on), then enforces `maxEntries` and
   * `maxBytes` over the live entries, oldest write first. Answers how many
   * expired entries and counters went. The listing pages are free of `HEAD`s
   * for objects the previous pass already read.
   */
  async sweep(now: number, limit: number): Promise<number> {
    this.#assertOpen();
    const memo = new Map<string, MemoEntry>();
    const live: CapCandidate[] = [];
    let removed = 0;
    let deletions = 0;
    let continuationToken: string | undefined;
    do {
      const page = await this.#client.list({
        prefix: `${this.prefix}/`,
        maxKeys: 1000,
        ...(continuationToken === undefined ? {} : { continuationToken }),
      });
      continuationToken = page.isTruncated
        ? page.nextContinuationToken
        : undefined;
      const ours = (page.contents ?? []).filter((object) =>
        /^[^/]+\/[esl]\//.test(object.key.slice(this.prefix.length + 1)),
      );
      const inspected = await mapLimit(ours, CONCURRENCY, async (object) => {
        try {
          return await this.#inspect(object, memo);
        } catch (error) {
          // Deleted since the listing: nothing to judge.
          if (isNoSuchKey(error)) {
            return undefined;
          }
          throw error;
        }
      });
      const expired: { key: string; etag: string; counted: boolean }[] = [];
      ours.forEach((object, index) => {
        const info = inspected[index];
        if (info?.kind === undefined) {
          return;
        }
        if (info.expiresAt !== null && info.expiresAt <= now) {
          expired.push({
            key: object.key,
            etag: info.etag,
            counted: info.kind === "entry" || info.kind === "counter",
          });
        } else if (info.kind === "entry") {
          live.push({
            key: object.key,
            size: object.size ?? 0,
            at: info.at ?? info.lastModified,
            etag: info.etag,
          });
        }
      });
      const allowed = expired.slice(0, Math.max(0, limit - deletions));
      deletions += allowed.length;
      await mapLimit(allowed, CONCURRENCY, async (object) => {
        await this.#sweepDelete(object.key, object.etag);
        memo.delete(object.key);
      });
      removed += allowed.filter((object) => object.counted).length;
    } while (continuationToken !== undefined);
    this.#sweepMemo = memo;
    await this.#enforceCaps(live);
    return removed;
  }

  /** Evicts the oldest live entries (by write time, then key) until the caps hold. */
  async #enforceCaps(live: CapCandidate[]): Promise<void> {
    const maxEntries = this.#maxEntries;
    const maxBytes = this.#maxBytes;
    if (maxEntries === undefined && maxBytes === undefined) {
      return;
    }
    let entries = live.length;
    let bytes = live.reduce((total, each) => total + each.size, 0);
    live.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
    const victims: CapCandidate[] = [];
    for (const candidate of live) {
      const over =
        (maxEntries !== undefined && entries > maxEntries) ||
        (maxBytes !== undefined && bytes > maxBytes);
      if (!over) {
        break;
      }
      victims.push(candidate);
      entries--;
      bytes -= candidate.size;
    }
    await mapLimit(victims, CONCURRENCY, async (victim) => {
      await this.#sweepDelete(victim.key, victim.etag);
      this.#sweepMemo.delete(victim.key);
    });
  }

  /** There is no schema; nothing to sync (§7.4). */
  syncSchema(_options?: SchemaSyncOptions): Promise<SchemaChange[]> {
    return Promise.resolve([]);
  }
}

/** An S3 driver (§7.8): one object per entry, stamp-mode tags, counters and locks on conditional writes. See {@link S3DriverOptions}. */
export function s3Driver(options: S3DriverOptions): CacheDriver {
  return new S3CacheDriver(options);
}
