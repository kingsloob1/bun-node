/**
 * The Azure Blob Storage driver (`azureBlobDriver`, plan Status of
 * 2026-10-27), over `fetch` with its own Shared Key signing
 * (`azure-sign.ts`): Bun has no Azure client, and the driver takes no Azure
 * SDK. Measured against Azurite 3.37.0 (`evidence/azure-spike.md`); real Azure
 * is untested.
 *
 * **Layout** — the S3 driver's (`s3.ts`), one block blob per object, in one
 * blob container (`<p>` is the prefix, `bun-cache` by default):
 *
 * ```
 * <p>/<ns>/e/<hh>/<sha256(key)>   an entry or a counter (the frame says which)
 * <p>/<ns>/s/<sha256(tag)>        a tag stamp, JSON { at, until }
 * <p>/<ns>/l/<sha256(key)>        a lock, JSON { owner, expiresAt }
 * ```
 *
 * The frame and the `Content-Type` (`application/x-bun-cache; exp=<ms>;
 * at=<ms>`, and `…-counter`, `…-stamp`, `…-lock`) are the S3 driver's,
 * shared through `blob-frame.ts`. Azure keeps the type's parameters and
 * returns them in a listing (measured), so the sweeper reads every object's
 * kind, expiry and write time from List Blobs alone, with no request per
 * object.
 *
 * - **Reads and writes** are Get Blob and Put Blob; `delete` is one Delete
 *   Blob per key, since Azure answers 202 or 404 (S3 needs a `HEAD` first).
 * - **Tags** are `stamps` (§3.6), and a stamp only moves forward (a read and
 *   a compare-and-swap), as on S3.
 * - **Counters and locks** are compare-and-swaps on conditional writes,
 *   which Azure's API has always had: create with `If-None-Match: *` (a lost
 *   race answers 409 `BlobAlreadyExists`), replace or delete with
 *   `If-Match: <etag>` (412 `ConditionNotMet`). One key's increments in a
 *   process are batched into one write; one lock blob's calls are queued.
 *   Not Lease Blob, Azure's own lock: a lease lasts 15–60 s or for ever, and
 *   the cache's lock TTL is anything from 1 s up (the spike, "Leases:
 *   measured, not used").
 * - **Expiry** is lazy on read plus the sweeper (`ttl: "sweep"`); a lifecycle
 *   management rule on `<p>/` is the operator's backstop. `maxEntries` and
 *   `maxBytes` evict oldest write first (age order, not LRU).
 * - **No bus** (`bus: "none"`): give the cache `redisBus` or `pgBus` for an L1.
 * - **No retries of its own**: a throttled request (503 `ServerBusy`) fails,
 *   and the cache's failure policy (§3.14) takes over. A conditional write is
 *   never retried blindly: one that landed but whose answer was lost would be
 *   applied twice.
 */
import { Buffer } from "node:buffer";
import type {
  CacheDriver,
  CacheDriverCapabilities,
  SchemaChange,
  SchemaSyncOptions,
  StoredEntry,
  TagFence,
} from "../core/types";
import type { AzureSigningTarget } from "./azure-sign";
import { azureFetch } from "./azure-sign";
import type { LockBody, PendingIncrement, StampBody } from "./blob-frame";
import {
  backoff,
  CONCURRENCY,
  contentType,
  decodeFrame,
  DECODER,
  encodeCounter,
  encodeEntry,
  ENCODER,
  hash,
  mapLimit,
  MAX_CAS_ATTEMPTS,
  parseContentType,
  segment,
} from "./blob-frame";

/** The default blob-name prefix (§7, §21: `bun-cache`, as S3's). */
export const DEFAULT_AZURE_PREFIX = "bun-cache";

/** One Put Blob holds 5000 MiB (version 2019-12-12 and later); a MiB is left for the frame's header. */
const MAX_ENTRY_BYTES = 5000 * 1024 * 1024 - 1024 * 1024;

/** The most blobs one List Blobs page answers (Azure's own ceiling). */
const LIST_PAGE = 5000;

/** Azurite's well-known development account, for `UseDevelopmentStorage=true` (published by Microsoft; not a secret). */
const DEVELOPMENT_ACCOUNT = "devstoreaccount1";

/** Azurite's well-known development key; see {@link DEVELOPMENT_ACCOUNT}. */
const DEVELOPMENT_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

/** Where the blob container is and how to sign for it: fields, or Azure's own connection string. */
export interface AzureBlobConnection {
  /**
   * Azure's connection string, as the portal shows it:
   * `DefaultEndpointsProtocol=https;AccountName=…;AccountKey=…;EndpointSuffix=core.windows.net`,
   * or with `BlobEndpoint=…` instead of the protocol and suffix, or
   * `UseDevelopmentStorage=true` for Azurite on 127.0.0.1:10000. Shared Key
   * only: a `SharedAccessSignature` is refused. It names no blob container,
   * so `container` is still needed. The fields below win over it.
   */
  connectionString?: string;
  /** The storage account's name. */
  accountName?: string;
  /** The account key, base64, as the portal shows it. */
  accountKey?: string;
  /**
   * The blob endpoint, `scheme://host[:port][/path]`. Defaults to
   * `https://<accountName>.blob.core.windows.net`. A path-style emulator
   * endpoint carries the account in its path, as Azurite's
   * `http://127.0.0.1:10000/devstoreaccount1` does.
   */
  endpoint?: string;
  /** The blob container the cache's blobs live in. It must exist: the driver never creates one. */
  container?: string;
}

/** `azureBlobDriver()`'s options: where the blob container is (a URL or a connection), and the driver's own. */
export interface AzureBlobDriverOptions {
  /**
   * `azure://<accountName>:<accountKey>@<host>[:<port>][/<path>]/<container>`,
   * with an optional `?scheme=http` (the default is `https`; `http` is for a
   * local emulator). The blob endpoint is `scheme://host[:port][/path]`: on
   * Azure `azure://acct:KEY@acct.blob.core.windows.net/cache`, on Azurite
   * `azure://devstoreaccount1:KEY@127.0.0.1:10000/devstoreaccount1/cache?scheme=http`.
   * The name and key are percent-decoded, so a key's `/`, `+` and `=` are
   * written `%2F`, `%2B`, `%3D`. Wins over the same fields of `connection`.
   */
  url?: string;
  /** The account, key, endpoint and container as fields, or Azure's connection string. */
  connection?: AzureBlobConnection;
  /**
   * Prepended to every blob name (`<prefix>/<ns>/…`). Defaults to
   * `bun-cache`. Must not be empty or start with `/`; a trailing `/` is
   * dropped. The sweeper walks everything under it, so give each cache's
   * blobs a prefix of their own.
   */
  prefix?: string;
  /**
   * At most this many entries; the oldest by write time go first, enforced by
   * the sweeper (so the container can briefly exceed it between sweeps).
   * Counters are never counted or evicted. Uncapped by default.
   */
  maxEntries?: number;
  /** At most this many bytes of entries (the blobs' sizes); the oldest go first, as `maxEntries`. Uncapped by default. */
  maxBytes?: number;
  /** The clock, epoch ms. Internal: for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** One blob of a List Blobs page. */
export interface ListedBlob {
  /** The blob's name, entities decoded. */
  name: string;
  /** Its ETag, as the listing gives it (unquoted; `If-Match` takes it as is). */
  etag: string;
  /** Its size, bytes. */
  size: number;
  /** Its `Content-Type`, entities decoded; `""` when it has none. */
  type: string;
  /** Its `Last-Modified`, epoch ms (whole seconds). */
  lastModified: number;
}

/** One entry the sweeper may evict for the caps. */
interface CapCandidate {
  /** The blob's name. */
  name: string;
  /** Its size, bytes. */
  size: number;
  /** When it was written, epoch ms. */
  at: number;
  /** Its ETag, for the conditional delete. */
  etag: string;
}

/** Decodes the five XML entities a listing escapes names and types with. */
function xmlDecode(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi,
    (whole, name: string, decimal?: string, hex?: string) => {
      if (decimal !== undefined) {
        return String.fromCodePoint(Number(decimal));
      }
      if (hex !== undefined) {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      };
      return named[name.toLowerCase()] ?? whole;
    },
  );
}

/** The text of `<tag>…</tag>` inside `xml`, decoded; `undefined` when absent. */
function xmlField(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match === null ? undefined : xmlDecode(match[1]);
}

/** Reads one List Blobs answer: its blobs, and the marker of the next page (`undefined` on the last). */
export function parseBlobList(xml: string): {
  blobs: ListedBlob[];
  next: string | undefined;
} {
  const blobs: ListedBlob[] = [];
  for (const [, body] of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
    blobs.push({
      name: xmlField(body, "Name") ?? "",
      etag: xmlField(body, "Etag") ?? "",
      size: Number(xmlField(body, "Content-Length") ?? 0),
      type: xmlField(body, "Content-Type") ?? "",
      lastModified: Date.parse(xmlField(body, "Last-Modified") ?? "") || 0,
    });
  }
  const next = xmlField(xml, "NextMarker");
  return { blobs, next: next === "" ? undefined : next };
}

/** A failed request's description: its status and Azure's error code. */
function failure(response: Response): string {
  return `${response.status} ${response.headers.get("x-ms-error-code") ?? ""}`.trim();
}

/** Whether a conditional write lost its race: 412 `ConditionNotMet`, or 409 `BlobAlreadyExists` for a create-only one. */
function isConflict(status: number): boolean {
  return status === 412 || status === 409;
}

/**
 * Reads the driver's `azure://` URL into connection fields. Throws a
 * `TypeError` naming what is wrong.
 */
export function parseAzureUrl(url: string): AzureBlobConnection {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("azureBlobDriver: url is not a URL");
  }
  if (parsed.protocol !== "azure:") {
    throw new TypeError(
      `azureBlobDriver: url must start with azure://, not ${parsed.protocol}//`,
    );
  }
  const path = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((part) => part !== "");
  const container = path.pop();
  if (parsed.host === "" || container === undefined) {
    throw new TypeError(
      "azureBlobDriver: url must be azure://<accountName>:<accountKey>@<host>[:<port>][/<path>]/<container>",
    );
  }
  const scheme = parsed.searchParams.get("scheme") ?? "https";
  if (scheme !== "https" && scheme !== "http") {
    throw new TypeError(
      `azureBlobDriver: the url's scheme parameter must be https or http, not ${scheme}`,
    );
  }
  const out: AzureBlobConnection = {
    endpoint: `${scheme}://${parsed.host}${path.length > 0 ? `/${path.join("/")}` : ""}`,
    container: decodeURIComponent(container),
  };
  if (parsed.username !== "") {
    out.accountName = decodeURIComponent(parsed.username);
  }
  if (parsed.password !== "") {
    out.accountKey = decodeURIComponent(parsed.password);
  }
  return out;
}

/**
 * Reads Azure's connection string into connection fields (Shared Key only).
 * Keys are case-insensitive; a value may hold `=` (a base64 key does).
 */
export function parseConnectionString(text: string): AzureBlobConnection {
  const fields = new Map<string, string>();
  for (const part of text.split(";")) {
    const at = part.indexOf("=");
    if (part.trim() === "") {
      continue;
    }
    if (at <= 0) {
      throw new TypeError(
        `azureBlobDriver: the connection string has a part with no name=value: ${JSON.stringify(part.split("=")[0])}`,
      );
    }
    fields.set(
      part.slice(0, at).trim().toLowerCase(),
      part.slice(at + 1).trim(),
    );
  }
  if (fields.has("sharedaccesssignature")) {
    throw new TypeError(
      "azureBlobDriver: a SharedAccessSignature connection string is not supported; use one with AccountName and AccountKey (Shared Key)",
    );
  }
  if (fields.get("usedevelopmentstorage")?.toLowerCase() === "true") {
    const proxy = fields.get("developmentstorageproxyuri");
    return {
      accountName: DEVELOPMENT_ACCOUNT,
      accountKey: DEVELOPMENT_KEY,
      endpoint: `${(proxy ?? "http://127.0.0.1").replace(/\/+$/, "")}:10000/${DEVELOPMENT_ACCOUNT}`,
    };
  }
  const out: AzureBlobConnection = {};
  const name = fields.get("accountname");
  const key = fields.get("accountkey");
  if (name !== undefined) {
    out.accountName = name;
  }
  if (key !== undefined) {
    out.accountKey = key;
  }
  const blobEndpoint = fields.get("blobendpoint");
  if (blobEndpoint !== undefined) {
    out.endpoint = blobEndpoint;
  } else if (name !== undefined) {
    const protocol = fields.get("defaultendpointsprotocol") ?? "https";
    const suffix = fields.get("endpointsuffix") ?? "core.windows.net";
    out.endpoint = `${protocol}://${name}.blob.${suffix}`;
  }
  return out;
}

/**
 * The signing target from the options: the URL over the connection's fields
 * over its connection string, then the endpoint's default. Throws a
 * `TypeError` naming what is missing or wrong.
 */
export function resolveAzureTarget(
  options: Pick<AzureBlobDriverOptions, "url" | "connection">,
): AzureSigningTarget {
  if (options.url === undefined && options.connection === undefined) {
    throw new TypeError(
      "azureBlobDriver needs a url or a connection (fields or a connectionString)",
    );
  }
  const { connectionString, ...fields } = options.connection ?? {};
  const merged: AzureBlobConnection = {
    ...(connectionString === undefined
      ? {}
      : parseConnectionString(connectionString)),
    ...Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ),
    ...(options.url === undefined ? {} : parseAzureUrl(options.url)),
  };
  const missing = (["accountName", "accountKey", "container"] as const).filter(
    (field) => merged[field] === undefined || merged[field] === "",
  );
  if (missing.length > 0) {
    throw new TypeError(
      `azureBlobDriver: no ${missing.join(", ")} (from the url, the connection's fields or its connectionString)`,
    );
  }
  const key = merged.accountKey!;
  if (
    !/^[a-z0-9+/]+={0,2}$/i.test(key) ||
    Buffer.from(key, "base64").length === 0
  ) {
    throw new TypeError(
      "azureBlobDriver: accountKey must be the account's base64 key (in a url, percent-encode its /, + and =)",
    );
  }
  const endpoint = (
    merged.endpoint ?? `https://${merged.accountName}.blob.core.windows.net`
  ).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]/.test(endpoint)) {
    throw new TypeError(
      `azureBlobDriver: endpoint must be http(s)://host[:port][/path]; got ${JSON.stringify(endpoint)}`,
    );
  }
  return {
    endpoint,
    account: merged.accountName!,
    key,
    container: merged.container!,
  };
}

/** The Azure Blob Storage driver. See the module header and {@link AzureBlobDriverOptions}. */
export class AzureBlobCacheDriver implements CacheDriver {
  /** `"azure-blob"`. */
  readonly name = "azure-blob";

  /** Lazy expiry plus the sweeper, stamp-mode tags, counters and locks on conditional writes, no bus. */
  readonly capabilities: CacheDriverCapabilities = {
    multiProcess: true,
    ttl: "sweep",
    atomicIncrement: true,
    lock: true,
    tags: "stamps",
    fence: "atomic",
    bus: "none",
    maxEntryBytes: MAX_ENTRY_BYTES,
  };

  /** The blob-name prefix, as resolved. Internal; read by the tests. */
  readonly prefix: string;

  /** The account, key, endpoint and container every request signs for. Internal; read by the tests. */
  readonly target: AzureSigningTarget;

  /** The `maxEntries` cap; `undefined` for none. */
  readonly #maxEntries: number | undefined;

  /** The `maxBytes` cap; `undefined` for none. */
  readonly #maxBytes: number | undefined;

  /** The clock. */
  readonly #now: () => number;

  /** The connect check (one listing), shared; cleared when it fails. */
  #connected: Promise<void> | undefined;

  /** Each key's queued increments, by blob name, while a batch is running. */
  readonly #counterQueues = new Map<string, PendingIncrement[]>();

  /** The last lock call queued on each lock blob in this process (see `#serially`). */
  readonly #lockChains = new Map<string, Promise<void>>();

  /** Set once `close()` ran. */
  #closed = false;

  constructor(
    /** The options: a URL or a connection, and the driver's own. */ options: AzureBlobDriverOptions,
  ) {
    const prefix = (options.prefix ?? DEFAULT_AZURE_PREFIX).replace(/\/+$/, "");
    if (prefix === "" || prefix.startsWith("/")) {
      throw new TypeError(
        `azureBlobDriver: prefix must not be empty or start with /; got ${JSON.stringify(options.prefix)}`,
      );
    }
    this.prefix = prefix;
    for (const cap of ["maxEntries", "maxBytes"] as const) {
      const value = options[cap];
      if (value !== undefined && !(Number.isSafeInteger(value) && value > 0)) {
        throw new TypeError(
          `azureBlobDriver: ${cap} must be a positive whole number; got ${String(value)}`,
        );
      }
    }
    this.#maxEntries = options.maxEntries;
    this.#maxBytes = options.maxBytes;
    this.#now = options.now ?? Date.now;
    this.target = resolveAzureTarget(options);
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Checks the blob container answers (one listing of one blob under the prefix). Idempotent. */
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

  /** One listing of at most one blob; a missing container is named. */
  async ping(): Promise<void> {
    await this.#list(`${this.prefix}/`, undefined, 1);
  }

  /** Throws once the driver is closed. */
  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("the azure-blob cache driver is closed");
    }
  }

  /* ---------------------------------------------------------------- */
  /* paths                                                             */
  /* ---------------------------------------------------------------- */

  /** The namespace's name prefix. */
  #nsPath(ns: string): string {
    return `${this.prefix}/${segment(ns)}`;
  }

  /** The blob of an entry or counter. */
  #entryPath(ns: string, key: string): string {
    const hashed = hash(key);
    return `${this.#nsPath(ns)}/e/${hashed.slice(0, 2)}/${hashed}`;
  }

  /** The blob of a tag's stamp. */
  #stampPath(ns: string, tag: string): string {
    return `${this.#nsPath(ns)}/s/${hash(tag)}`;
  }

  /** The blob of a lock. */
  #lockPath(ns: string, key: string): string {
    return `${this.#nsPath(ns)}/l/${hash(key)}`;
  }

  /* ---------------------------------------------------------------- */
  /* the REST calls                                                    */
  /* ---------------------------------------------------------------- */

  /** One page of List Blobs under `prefix`. */
  async #list(
    prefix: string,
    marker: string | undefined,
    max = LIST_PAGE,
  ): Promise<{ blobs: ListedBlob[]; next: string | undefined }> {
    const response = await azureFetch(this.target, {
      method: "GET",
      blob: "",
      query: {
        restype: "container",
        comp: "list",
        prefix,
        maxresults: String(max),
        ...(marker === undefined ? {} : { marker }),
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `azureBlobDriver: listing the container ${this.target.container} at ${this.target.endpoint} answered ${failure(response)}`,
      );
    }
    return parseBlobList(await response.text());
  }

  /** Get Blob: the blob's bytes and ETag, or `undefined` when it does not exist. */
  async #read(
    path: string,
  ): Promise<{ bytes: Uint8Array; etag: string } | undefined> {
    const response = await azureFetch(this.target, {
      method: "GET",
      blob: path,
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `azureBlobDriver: GET ${path} answered ${failure(response)}`,
      );
    }
    const etag = response.headers.get("etag");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (etag === null) {
      throw new Error(`azureBlobDriver: GET ${path} answered no ETag`);
    }
    return { bytes, etag };
  }

  /**
   * Put Blob, plain or conditional: `ifMatch` an ETag, or `"*"` for
   * create-only (`If-None-Match: *`). Answers `true` when written, `false`
   * when the condition failed.
   */
  async #put(
    path: string,
    body: Uint8Array,
    type: string,
    condition?: { ifMatch: string } | { ifNoneMatch: "*" },
  ): Promise<boolean> {
    const headers: Record<string, string> = {
      "x-ms-blob-type": "BlockBlob",
      "content-type": type,
    };
    if (condition !== undefined && "ifMatch" in condition) {
      headers["if-match"] = condition.ifMatch;
    } else if (condition !== undefined) {
      headers["if-none-match"] = "*";
    }
    const response = await azureFetch(this.target, {
      method: "PUT",
      blob: path,
      headers,
      body,
    });
    await response.body?.cancel();
    if (response.ok) {
      return true;
    }
    if (condition !== undefined && isConflict(response.status)) {
      return false;
    }
    throw new Error(
      `azureBlobDriver: PUT ${path} answered ${failure(response)}`,
    );
  }

  /** Delete Blob, only while it still has `etag` when one is given; answers whether it went. */
  async #delete(path: string, etag?: string): Promise<boolean> {
    const response = await azureFetch(this.target, {
      method: "DELETE",
      blob: path,
      headers: etag === undefined ? {} : { "if-match": etag },
    });
    await response.body?.cancel();
    if (response.ok) {
      return true;
    }
    if (response.status === 404 || response.status === 412) {
      return false;
    }
    throw new Error(
      `azureBlobDriver: DELETE ${path} answered ${failure(response)}`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* entries                                                           */
  /* ---------------------------------------------------------------- */

  async get(ns: string, key: string): Promise<StoredEntry | undefined> {
    this.#assertOpen();
    const path = this.#entryPath(ns, key);
    const read = await this.#read(path);
    if (read === undefined) {
      return undefined;
    }
    const frame = decodeFrame(read.bytes);
    if (frame === undefined || frame.kind !== "entry") {
      return undefined;
    }
    if (frame.expiresAt !== null && frame.expiresAt <= this.#now()) {
      // Lazy expiry: reclaimed in the background, only if still the blob
      // just read, so a write landing in between is never lost.
      void this.#delete(path, read.etag).catch(() => undefined);
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
    await this.#put(
      this.#entryPath(ns, entry.key),
      encodeEntry(entry),
      contentType("entry", entry.expiresAt, this.#now()),
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

  /** Deletes entries and counters: one Delete Blob per key, which answers whether the blob was there. */
  async delete(ns: string, keys: readonly string[]): Promise<number> {
    this.#assertOpen();
    const removed = await mapLimit(keys, CONCURRENCY, async (key) =>
      (await this.#delete(this.#entryPath(ns, key))) ? 1 : 0,
    );
    return removed.reduce<number>((total, each) => total + each, 0);
  }

  /** Deletes the namespace's entries and counters, page by page. Stamps and locks stay, as on SQL, Redis and S3. Not atomic. */
  async clear(ns: string): Promise<void> {
    this.#assertOpen();
    const prefix = `${this.#nsPath(ns)}/e/`;
    // Paged by marker, not re-listed from the start until empty: a blob that
    // cannot be deleted (leased by someone else: 412) would loop for ever.
    let marker: string | undefined;
    do {
      const page = await this.#list(prefix, marker);
      marker = page.next;
      await mapLimit(page.blobs, CONCURRENCY, async (blob) => {
        await this.#delete(blob.name);
      });
    } while (marker !== undefined);
  }

  /**
   * Rewrites an entry's (or counter's) expiry: a blob cannot change in
   * place, so it is a read and a compare-and-swap, and a `set` landing in
   * between is never overwritten by the old value.
   */
  async touch(
    ns: string,
    key: string,
    expiresAt: number | null,
  ): Promise<boolean> {
    this.#assertOpen();
    const path = this.#entryPath(ns, key);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const read = await this.#read(path);
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
      if (
        await this.#put(path, body, contentType(frame.kind, expiresAt, now), {
          ifMatch: read.etag,
        })
      ) {
        return true;
      }
      await backoff(attempt);
    }
    throw new Error(
      `azureBlobDriver: touch ${path} lost ${MAX_CAS_ATTEMPTS} races in a row`,
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
      const blob = await this.#read(this.#stampPath(ns, tag));
      if (blob === undefined) {
        return undefined;
      }
      try {
        const stamp = JSON.parse(DECODER.decode(blob.bytes)) as StampBody;
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
   * Writes each tag's stamp, moving it forward only: read with its ETag and
   * replaced (`If-Match`, or created with `If-None-Match: *`) by the later of
   * the two invalidation times and lifetimes — so of two invalidations of one
   * tag a moment apart, the older never lands last.
   */
  async setStamps(
    ns: string,
    tags: readonly string[],
    at: number,
    until: number,
  ): Promise<void> {
    this.#assertOpen();
    await mapLimit(tags, CONCURRENCY, async (tag) => {
      await this.#advanceStamp(this.#stampPath(ns, tag), at, until);
    });
  }

  /** Moves one stamp forward to `at`/`until` with a compare-and-swap; a stamp already as late is left alone. */
  async #advanceStamp(path: string, at: number, until: number): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const read = await this.#read(path);
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
      const written = await this.#put(
        path,
        ENCODER.encode(JSON.stringify(body)),
        contentType("stamp", body.until, this.#now()),
        read === undefined ? { ifNoneMatch: "*" } : { ifMatch: read.etag },
      );
      if (written) {
        return;
      }
      await backoff(attempt);
    }
    throw new Error(
      `azureBlobDriver: stamp ${path} lost ${MAX_CAS_ATTEMPTS} races in a row`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* counters (§3.8: compare-and-swap, batched per key)                */
  /* ---------------------------------------------------------------- */

  /**
   * Adds `by` atomically. Concurrent calls on one key in this process join one
   * queue: each batch is one compare-and-swap adding the batch's sum, and each
   * call gets its own value in order — 200 callers cost a handful of writes,
   * where 200 unbatched contenders lost ~2,400 races on Azurite (the spike).
   */
  async increment(
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ): Promise<number> {
    this.#assertOpen();
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
        void this.#drainCounter(path, queue);
      }
    });
  }

  /** Runs a key's queued increments, a batch at a time, until none are left. */
  async #drainCounter(path: string, queue: PendingIncrement[]): Promise<void> {
    try {
      // Let the callers of this tick join the first batch.
      await Promise.resolve();
      while (queue.length > 0) {
        const batch = queue.splice(0);
        try {
          let value = await this.#addToCounter(path, batch);
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
    path: string,
    batch: readonly PendingIncrement[],
  ): Promise<number> {
    const sum = batch.reduce((total, call) => total + call.by, 0);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const now = this.#now();
      const read = await this.#read(path);
      const frame = read === undefined ? undefined : decodeFrame(read.bytes);
      const live =
        frame?.kind === "counter" &&
        (frame.expiresAt === null || frame.expiresAt > now)
          ? frame
          : undefined;
      const base = live?.value ?? 0;
      const expiresAt =
        live === undefined ? batch[0].expiresAt : live.expiresAt;
      const written = await this.#put(
        path,
        encodeCounter(base + sum, expiresAt, live?.createdAt ?? now),
        contentType("counter", expiresAt, now),
        read === undefined ? { ifNoneMatch: "*" } : { ifMatch: read.etag },
      );
      if (written) {
        return base;
      }
      await backoff(attempt);
    }
    throw new Error(
      `azureBlobDriver: increment ${path} lost ${MAX_CAS_ATTEMPTS} races in a row`,
    );
  }

  async getCounter(
    ns: string,
    key: string,
  ): Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  > {
    this.#assertOpen();
    const read = await this.#read(this.#entryPath(ns, key));
    const frame = read === undefined ? undefined : decodeFrame(read.bytes);
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
  /* locks (conditional writes, not leases)                            */
  /* ---------------------------------------------------------------- */

  /**
   * Runs `run` after every earlier lock call on the same blob in this
   * process: one process's contenders queue here rather than each sending a
   * conditional write only one can win (Azure bills the failed ones).
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
    const path = this.#lockPath(ns, key);
    return await this.#serially(path, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const now = this.#now();
        const lock: LockBody = { owner, expiresAt: now + ttlMs };
        const body = ENCODER.encode(JSON.stringify(lock));
        const type = contentType("lock", lock.expiresAt, now);
        const read = await this.#read(path);
        if (read === undefined) {
          if (await this.#put(path, body, type, { ifNoneMatch: "*" })) {
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
        return await this.#put(path, body, type, { ifMatch: read.etag });
      }
      return false;
    });
  }

  /** Compare-and-delete: reads the lock and deletes it with `If-Match` only while `owner` holds it. */
  async releaseLock(ns: string, key: string, owner: string): Promise<boolean> {
    this.#assertOpen();
    const path = this.#lockPath(ns, key);
    return await this.#serially(path, async () => {
      const read = await this.#read(path);
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
      return await this.#delete(path, read.etag);
    });
  }

  /* ---------------------------------------------------------------- */
  /* the sweeper                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Walks every blob under the prefix — the listing alone says each one's
   * kind, expiry and write time — and deletes the expired ones (entries,
   * counters, stamps, locks; at most `limit`, each only if unchanged since
   * it was listed), then enforces `maxEntries` and `maxBytes` over the live
   * entries, oldest write first. Answers how many expired entries and
   * counters went.
   */
  async sweep(now: number, limit: number): Promise<number> {
    this.#assertOpen();
    const live: CapCandidate[] = [];
    let removed = 0;
    let deletions = 0;
    let marker: string | undefined;
    do {
      const page = await this.#list(`${this.prefix}/`, marker);
      marker = page.next;
      const expired: { name: string; etag: string; counted: boolean }[] = [];
      for (const blob of page.blobs) {
        if (!/^[^/]+\/[esl]\//.test(blob.name.slice(this.prefix.length + 1))) {
          continue;
        }
        const info = parseContentType(blob.type);
        if (info.kind === undefined) {
          continue;
        }
        if (info.expiresAt !== null && info.expiresAt <= now) {
          expired.push({
            name: blob.name,
            etag: blob.etag,
            counted: info.kind === "entry" || info.kind === "counter",
          });
        } else if (info.kind === "entry") {
          live.push({
            name: blob.name,
            size: blob.size,
            at: info.at ?? blob.lastModified,
            etag: blob.etag,
          });
        }
      }
      const allowed = expired.slice(0, Math.max(0, limit - deletions));
      deletions += allowed.length;
      const gone = await mapLimit(
        allowed,
        CONCURRENCY,
        async (blob) =>
          (await this.#delete(blob.name, blob.etag)) && blob.counted,
      );
      removed += gone.filter(Boolean).length;
    } while (marker !== undefined);
    await this.#enforceCaps(live);
    return removed;
  }

  /** Evicts the oldest live entries (by write time, then name) until the caps hold. */
  async #enforceCaps(live: CapCandidate[]): Promise<void> {
    const maxEntries = this.#maxEntries;
    const maxBytes = this.#maxBytes;
    if (maxEntries === undefined && maxBytes === undefined) {
      return;
    }
    let entries = live.length;
    let bytes = live.reduce((total, each) => total + each.size, 0);
    live.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1));
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
      await this.#delete(victim.name, victim.etag);
    });
  }

  /** There is no schema; nothing to sync (§7.4). */
  syncSchema(_options?: SchemaSyncOptions): Promise<SchemaChange[]> {
    return Promise.resolve([]);
  }
}

/** An Azure Blob Storage driver: one block blob per entry, stamp-mode tags, counters and locks on conditional writes. See {@link AzureBlobDriverOptions}. */
export function azureBlobDriver(options: AzureBlobDriverOptions): CacheDriver {
  return new AzureBlobCacheDriver(options);
}
