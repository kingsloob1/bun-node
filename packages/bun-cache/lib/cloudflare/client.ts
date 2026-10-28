/**
 * The HTTP client the Cloudflare drivers share (plan Status, the Cloudflare
 * spike: `docs/plans/bun-cache/evidence/cloudflare-spike.md`). bun-cache runs
 * in a Bun process, not in a Worker, so it reaches KV and D1 over HTTP, by one
 * of two transports speaking the same request shapes — the REST API's:
 *
 * - **The REST API** (`https://api.cloudflare.com/client/v4/accounts/<id>`),
 *   with an API token. Nothing to deploy, but Cloudflare caps it at 1,200
 *   requests per five minutes per user or token, shared with Wrangler and
 *   the dashboard, and answers 429 for the next five minutes once it is
 *   exceeded. The client paces itself under that budget (a sliding window),
 *   so this process never trips it alone.
 * - **The bun-cache Worker** (`@kingsleyweb/bun-cache/cloudflare-worker`,
 *   deployed by the user with KV and D1 bindings), at its own URL, with the
 *   Worker's secret. No API cap; the README recommends it for production.
 *
 * **429s**, from either: the request is retried after `Retry-After` (or a
 * growing, jittered backoff from 1 s when there is none), at most
 * {@link MAX_ATTEMPTS} times. A wait longer than {@link MAX_RETRY_WAIT_MS}
 * (the REST API's five-minute block) is not slept through: the client
 * remembers it and fails every request until it passes, rather than hold a
 * cache operation for minutes. KV answers 429 to a second write to one key
 * within a second; that is the common case, and one retry clears it.
 */
import { Buffer } from "node:buffer";
import process from "node:process";

/** The REST API's base, before the account. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** The REST API's documented budget: 1,200 requests per five minutes per user or token. */
export const REST_API_BUDGET = { requests: 1_200, windowMs: 300_000 };

/** The most attempts one request makes through 429s. */
export const MAX_ATTEMPTS = 6;

/** The longest 429 wait the client sleeps through; a longer one fails fast until it passes. */
export const MAX_RETRY_WAIT_MS = 10_000;

/** KV's shortest expiry: `expiration_ttl` must be at least 60 s (Cloudflare refuses less; workerd too, measured). */
export const KV_MIN_TTL_SECONDS = 60;

/** A request budget: at most `requests` in any `windowMs`. */
export interface CloudflareRequestBudget {
  /** How many requests the window allows. */
  requests: number;
  /** The window, in ms. */
  windowMs: number;
}

/** {@link CloudflareClient}'s options; the drivers pass theirs through. */
export interface CloudflareClientOptions {
  /** The account's id, for the REST API; `CLOUDFLARE_ACCOUNT_ID` when absent. Ignored with an `endpoint`. */
  accountId?: string;
  /**
   * The bearer token: an API token for the REST API (`CLOUDFLARE_API_TOKEN`
   * when absent), or the Worker's `BUN_CACHE_PROXY_TOKEN` secret with an
   * `endpoint` — given explicitly then: the environment's API token is never
   * sent to a Worker URL.
   */
  apiToken?: string;
  /**
   * The bun-cache Worker's URL; the REST API when absent. `https:` (or
   * `http:` to a loopback host, for local tests).
   */
  endpoint?: string;
  /** Who is asking, for error messages (`"cloudflareKvDriver"`). */
  caller: string;
  /**
   * The request budget the client paces under. Defaults to the REST API's
   * documented one ({@link REST_API_BUDGET}) for the REST API, and none
   * (`false`) for a Worker. Internal: for tests.
   */
  budget?: CloudflareRequestBudget | false;
}

/** One D1 statement: SQL and its parameters, strings only (the REST API's schema). */
export interface D1Statement {
  /** One SQL statement. The REST API accepts several joined by `;`; the Worker runs one, so send one. */
  sql: string;
  /** Its `?`/`?N` parameters, as strings (SQLite's affinity converts them; `NULLIF(?, '')` makes a null). */
  params?: readonly string[];
}

/** One statement's result from D1's `/query`. */
export interface D1QueryResult {
  /** The rows, as objects keyed by column. A BLOB comes as an array of byte values; read `hex(col)` instead. */
  results: Record<string, unknown>[];
  /** Whether the statement succeeded. */
  success: boolean;
  /** D1's statistics (`changes` counts trigger rows too, measured). */
  meta: {
    /** Rows changed, triggers included. */
    changes?: number;
    /** The last inserted rowid. */
    last_row_id?: number;
    /** Rows read (billed). */
    rows_read?: number;
    /** Rows written (billed). */
    rows_written?: number;
  } & Record<string, unknown>;
}

/** One statement's result from D1's `/raw`: column names and row arrays. */
export interface D1RawResult {
  /** The columns and rows. */
  results: {
    /** The column names. */
    columns: string[];
    /** Each row's values, in column order. */
    rows: unknown[][];
  };
  /** Whether the statement succeeded. */
  success: boolean;
  /** As {@link D1QueryResult.meta}. */
  meta: Record<string, unknown>;
}

/** One pair of a KV bulk write. */
export interface KvBulkPair {
  /** The key. */
  key: string;
  /** The value: bytes (sent base64) or text. */
  value: Uint8Array | string;
  /** Expiry, epoch ms; `null` for none. */
  expiresAt: number | null;
}

/** The REST API's JSON envelope. */
interface Envelope<T> {
  /** Whether the call succeeded. */
  success?: boolean;
  /** What went wrong. */
  errors?: { code?: number; message?: string }[];
  /** The answer. */
  result?: T;
  /** Paging, on a listing. */
  result_info?: { cursor?: string };
}

/** KV's "key not found" error code. */
const KV_KEY_NOT_FOUND = 10009;

/** How many keys one `bulk/get` takes (documented). */
export const KV_BULK_GET_LIMIT = 100;

/** How many pairs one bulk write or delete takes (documented: 10,000). */
export const KV_BULK_WRITE_LIMIT = 10_000;

/** How many request-body bytes one bulk write carries at most (documented: 100 MB; a margin left). */
const KV_BULK_WRITE_BYTES = 90_000_000;

/**
 * The `expiration_ttl` for an expiry: the seconds left, rounded up, and never
 * under KV's floor of 60. Relative, so the client's clock never trips
 * Cloudflare's "at least 60 seconds in the future" check. `undefined` for no
 * expiry. A shorter expiry is still exact for bun-cache: the driver's frame
 * carries the exact `expiresAt` and every read checks it; KV only reclaims
 * the key up to 60 s later.
 */
export function kvExpirationTtl(
  expiresAt: number | null,
  now: number,
): number | undefined {
  if (expiresAt === null) {
    return undefined;
  }
  return Math.max(KV_MIN_TTL_SECONDS, Math.ceil((expiresAt - now) / 1000));
}

/** Whether a URL's host is a loopback one, where plain `http:` is allowed. */
function isLoopback(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  );
}

/** Base64 of bytes, for a bulk write's `base64: true` value. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64",
  );
}

/** The `Retry-After` header in ms; `undefined` when absent or not a number of seconds. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * One client per driver. Never logs or reports its token.
 */
export class CloudflareClient {
  /** Which transport: the REST API or a bun-cache Worker. */
  readonly transport: "rest" | "worker";

  /** The base every path is appended to (no trailing `/`). */
  readonly base: string;

  /** Who is asking, for messages. */
  readonly #caller: string;

  /** The bearer token. */
  readonly #token: string;

  /** The pacing budget; `undefined` for none. */
  readonly #budget: CloudflareRequestBudget | undefined;

  /** When the last `budget.requests` requests started, oldest first. */
  readonly #started: number[] = [];

  /** Until when every request fails fast, after a 429 asked for a wait longer than {@link MAX_RETRY_WAIT_MS}; epoch ms. */
  #pausedUntil = 0;

  /** How many requests were sent (each attempt counts). Internal: for tests. */
  requests = 0;

  /** How many 429s were answered. Internal: for tests. */
  rateLimited = 0;

  constructor(
    /** Where to, and with what token. */ options: CloudflareClientOptions,
  ) {
    this.#caller = options.caller;
    if (options.endpoint !== undefined) {
      let url: URL;
      try {
        url = new URL(options.endpoint);
      } catch {
        throw new TypeError(`${options.caller}: endpoint is not a URL`);
      }
      if (
        url.protocol !== "https:" &&
        !(url.protocol === "http:" && isLoopback(url))
      ) {
        throw new TypeError(
          `${options.caller}: endpoint must be https: (http: only to a loopback host), not ${url.protocol}//${url.host}`,
        );
      }
      if (options.apiToken === undefined || options.apiToken === "") {
        throw new TypeError(
          `${options.caller}: an endpoint needs apiToken, the Worker's BUN_CACHE_PROXY_TOKEN secret (CLOUDFLARE_API_TOKEN is never sent to a Worker)`,
        );
      }
      this.transport = "worker";
      this.base = url.href.replace(/\/+$/, "");
      this.#token = options.apiToken;
      this.#budget = options.budget === false ? undefined : options.budget;
      return;
    }
    const accountId =
      options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || undefined;
    const apiToken =
      options.apiToken || process.env.CLOUDFLARE_API_TOKEN || undefined;
    if (accountId === undefined || apiToken === undefined) {
      throw new TypeError(
        `${options.caller} needs accountId and apiToken (or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN) for the REST API, or an endpoint and apiToken for a bun-cache Worker`,
      );
    }
    this.transport = "rest";
    this.base = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}`;
    this.#token = apiToken;
    this.#budget =
      options.budget === false
        ? undefined
        : (options.budget ?? REST_API_BUDGET);
  }

  /* ---------------------------------------------------------------- */
  /* the request loop: pacing, the pause, 429 retries                  */
  /* ---------------------------------------------------------------- */

  /** Waits for a slot in the budget's window, and claims it. */
  async #pace(): Promise<void> {
    const budget = this.#budget;
    if (budget === undefined) {
      return;
    }
    for (;;) {
      const now = Date.now();
      while (
        this.#started.length > 0 &&
        this.#started[0] <= now - budget.windowMs
      ) {
        this.#started.shift();
      }
      if (this.#started.length < budget.requests) {
        this.#started.push(now);
        return;
      }
      await Bun.sleep(this.#started[0] + budget.windowMs - now);
    }
  }

  /** Fails fast while paused for longer than {@link MAX_RETRY_WAIT_MS}; sleeps out a shorter pause. */
  async #respectPause(what: string): Promise<void> {
    const left = this.#pausedUntil - Date.now();
    if (left <= 0) {
      return;
    }
    if (left > MAX_RETRY_WAIT_MS) {
      throw new Error(
        `${this.#caller}: ${what}: rate limited by Cloudflare (429) for another ${Math.ceil(left / 1000)} s; not sent`,
      );
    }
    await Bun.sleep(left);
  }

  /**
   * Sends one request through pacing and 429 retries, and answers the
   * response for any other status. `path` is appended to {@link base}.
   */
  async request(
    /** The method. */ method: string,
    /** The path after the base, starting with `/`. */ path: string,
    /** The body and extra headers. */ init: {
      /** The body. */
      body?: string | Uint8Array;
      /** Extra headers. */
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const what = `${method} ${path.replace(/\?.*$/, "")}`;
    for (let attempt = 1; ; attempt++) {
      await this.#respectPause(what);
      await this.#pace();
      this.requests++;
      const response = await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.#token}`, ...init.headers },
        body: init.body,
      });
      if (response.status !== 429) {
        return response;
      }
      this.rateLimited++;
      // Read, not cancelled: a cancelled body resets the connection.
      await response.arrayBuffer().catch(() => undefined);
      const wait =
        retryAfterMs(response) ??
        Math.min(1000 * 2 ** (attempt - 1), 8_000) * (0.75 + Math.random() / 2);
      if (wait > MAX_RETRY_WAIT_MS) {
        this.#pausedUntil = Math.max(this.#pausedUntil, Date.now() + wait);
        throw new Error(
          `${this.#caller}: ${what}: rate limited by Cloudflare (429), retry after ${Math.ceil(wait / 1000)} s`,
        );
      }
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(
          `${this.#caller}: ${what}: still rate limited (429) after ${MAX_ATTEMPTS} attempts`,
        );
      }
      await Bun.sleep(wait);
    }
  }

  /** Reads a JSON envelope and answers its `result`, or throws with Cloudflare's errors. */
  async #json<T>(
    what: string,
    response: Response,
  ): Promise<{ result: T; envelope: Envelope<T> }> {
    const text = await response.text();
    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new Error(
        `${this.#caller}: ${what} answered ${response.status} with no JSON: ${text.slice(0, 200)}`,
      );
    }
    if (!response.ok || envelope.success !== true) {
      throw new Error(
        `${this.#caller}: ${what} answered ${response.status}: ${describeErrors(envelope)}`,
      );
    }
    return { result: envelope.result as T, envelope };
  }

  /* ---------------------------------------------------------------- */
  /* KV                                                                */
  /* ---------------------------------------------------------------- */

  /** A namespace's path. */
  #kv(namespaceId: string): string {
    return `/storage/kv/namespaces/${encodeURIComponent(namespaceId)}`;
  }

  /** A value's bytes; `undefined` when the key does not exist. */
  async kvGet(
    namespaceId: string,
    key: string,
  ): Promise<Uint8Array | undefined> {
    const path = `${this.#kv(namespaceId)}/values/${encodeURIComponent(key)}`;
    const response = await this.request("GET", path);
    if (response.ok) {
      return new Uint8Array(await response.arrayBuffer());
    }
    await this.#throwUnlessMissing("GET values", response);
    return undefined;
  }

  /**
   * Whether a key exists, from a value read (KV has no `HEAD`). A body of up
   * to 64 KiB is read and dropped; a larger one is cancelled unread, which
   * workerd logs as a reset connection.
   */
  async kvExists(namespaceId: string, key: string): Promise<boolean> {
    const path = `${this.#kv(namespaceId)}/values/${encodeURIComponent(key)}`;
    const response = await this.request("GET", path);
    if (response.ok) {
      const length = Number(response.headers.get("content-length") ?? "NaN");
      if (Number.isFinite(length) && length <= 65_536) {
        await response.arrayBuffer();
      } else {
        await response.body?.cancel();
      }
      return true;
    }
    await this.#throwUnlessMissing("GET values", response);
    return false;
  }

  /** A 404 "key not found" is a miss; anything else throws. */
  async #throwUnlessMissing(what: string, response: Response): Promise<void> {
    const text = await response.text();
    let envelope: Envelope<unknown> = {};
    try {
      envelope = JSON.parse(text) as Envelope<unknown>;
    } catch {
      // Not JSON: reported below.
    }
    if (
      response.status === 404 &&
      envelope.errors?.some((error) => error.code === KV_KEY_NOT_FOUND)
    ) {
      return;
    }
    throw new Error(
      `${this.#caller}: ${what} answered ${response.status}: ${envelope.errors === undefined ? text.slice(0, 200) : describeErrors(envelope)}`,
    );
  }

  /** Writes one value, raw, with its expiry (KV's 60 s floor applied, {@link kvExpirationTtl}). */
  async kvPut(
    namespaceId: string,
    key: string,
    value: Uint8Array | string,
    expiresAt: number | null,
    now: number,
  ): Promise<void> {
    const ttl = kvExpirationTtl(expiresAt, now);
    const query = ttl === undefined ? "" : `?expiration_ttl=${ttl}`;
    const path = `${this.#kv(namespaceId)}/values/${encodeURIComponent(key)}${query}`;
    const response = await this.request("PUT", path, {
      body: value,
      headers: { "content-type": "application/octet-stream" },
    });
    await this.#json("PUT values", response);
  }

  /**
   * Writes many pairs, in bulk requests of at most 10,000 pairs and ~90 MB
   * (bytes go base64; Cloudflare stores them decoded). Keys a bulk write
   * reports unsuccessful are retried, after a second, a few times.
   */
  async kvBulkPut(
    namespaceId: string,
    pairs: readonly KvBulkPair[],
    now: number,
  ): Promise<void> {
    const encoded = pairs.map((pair) => {
      const ttl = kvExpirationTtl(pair.expiresAt, now);
      return {
        key: pair.key,
        ...(typeof pair.value === "string"
          ? { value: pair.value }
          : { value: toBase64(pair.value), base64: true }),
        ...(ttl === undefined ? {} : { expiration_ttl: ttl }),
      };
    });
    let chunk: typeof encoded = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) {
        return;
      }
      await this.#bulkPutChunk(namespaceId, chunk);
      chunk = [];
      bytes = 0;
    };
    for (const pair of encoded) {
      const size = pair.key.length + pair.value.length + 64;
      if (
        chunk.length >= KV_BULK_WRITE_LIMIT ||
        (chunk.length > 0 && bytes + size > KV_BULK_WRITE_BYTES)
      ) {
        await flush();
      }
      chunk.push(pair);
      bytes += size;
    }
    await flush();
  }

  /** One bulk write; retries the keys it reports unsuccessful (KV's per-key write rate). */
  async #bulkPutChunk(
    namespaceId: string,
    chunk: readonly { key: string }[],
  ): Promise<void> {
    let pending = chunk;
    for (let attempt = 1; ; attempt++) {
      const response = await this.request(
        "PUT",
        `${this.#kv(namespaceId)}/bulk`,
        {
          body: JSON.stringify(pending),
          headers: { "content-type": "application/json" },
        },
      );
      const { result } = await this.#json<{
        unsuccessful_keys?: string[];
      } | null>("PUT bulk", response);
      const failed = new Set(result?.unsuccessful_keys ?? []);
      if (failed.size === 0) {
        return;
      }
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(
          `${this.#caller}: PUT bulk: ${failed.size} keys still unsuccessful after ${MAX_ATTEMPTS} attempts`,
        );
      }
      pending = pending.filter((pair) => failed.has(pair.key));
      await Bun.sleep(1000 * (0.75 + Math.random() / 2));
    }
  }

  /**
   * Reads up to any number of text values, 100 keys a request; `undefined`
   * for a missing key. Text only: Cloudflare's `bulk/get` refuses binary
   * values, so it serves stamps, never entries.
   */
  async kvBulkGetText(
    namespaceId: string,
    keys: readonly string[],
  ): Promise<(string | undefined)[]> {
    const out: (string | undefined)[] = [];
    for (let start = 0; start < keys.length; start += KV_BULK_GET_LIMIT) {
      const slice = keys.slice(start, start + KV_BULK_GET_LIMIT);
      const response = await this.request(
        "POST",
        `${this.#kv(namespaceId)}/bulk/get`,
        {
          body: JSON.stringify({ keys: slice, type: "text" }),
          headers: { "content-type": "application/json" },
        },
      );
      const { result } = await this.#json<{
        values?: Record<string, string | null>;
      }>("POST bulk/get", response);
      for (const key of slice) {
        const value = result.values?.[key];
        out.push(typeof value === "string" ? value : undefined);
      }
    }
    return out;
  }

  /** Deletes keys, 10,000 a request. KV answers alike whether or not a key existed. */
  async kvBulkDelete(
    namespaceId: string,
    keys: readonly string[],
  ): Promise<void> {
    for (let start = 0; start < keys.length; start += KV_BULK_WRITE_LIMIT) {
      const response = await this.request(
        "POST",
        `${this.#kv(namespaceId)}/bulk/delete`,
        {
          body: JSON.stringify(keys.slice(start, start + KV_BULK_WRITE_LIMIT)),
          headers: { "content-type": "application/json" },
        },
      );
      await this.#json("POST bulk/delete", response);
    }
  }

  /** One page of keys under a prefix (at most `limit`, 10–1,000); `cursor` is `undefined` on the last page. */
  async kvList(
    namespaceId: string,
    prefix: string,
    options: {
      /** The previous page's cursor. */
      cursor?: string;
      /** The page size, 10–1,000; 1,000 by default. */
      limit?: number;
    } = {},
  ): Promise<{ keys: string[]; cursor: string | undefined }> {
    const query = new URLSearchParams({
      prefix,
      limit: String(options.limit ?? 1000),
    });
    if (options.cursor !== undefined) {
      query.set("cursor", options.cursor);
    }
    const response = await this.request(
      "GET",
      `${this.#kv(namespaceId)}/keys?${query}`,
    );
    const { result, envelope } = await this.#json<{ name: string }[]>(
      "GET keys",
      response,
    );
    const cursor = envelope.result_info?.cursor;
    return {
      keys: result.map((each) => each.name),
      cursor: cursor === undefined || cursor === "" ? undefined : cursor,
    };
  }

  /* ---------------------------------------------------------------- */
  /* D1                                                                */
  /* ---------------------------------------------------------------- */

  /** A database's path. */
  #d1(databaseId: string): string {
    return `/d1/database/${encodeURIComponent(databaseId)}`;
  }

  /** The body for one statement or a batch. */
  #d1Body(statements: readonly D1Statement[]): string {
    const each = statements.map((statement) =>
      statement.params === undefined || statement.params.length === 0
        ? { sql: statement.sql }
        : { sql: statement.sql, params: [...statement.params] },
    );
    return JSON.stringify(each.length === 1 ? each[0] : { batch: each });
  }

  /**
   * Runs statements through D1's `/query`, one request: a single statement,
   * or a batch. A batch is a transaction through the Worker (`DB.batch()`);
   * the REST API does not document whether its batch is, so a driver that
   * needs atomicity writes it as one statement (the spike).
   */
  async d1Query(
    databaseId: string,
    statements: readonly D1Statement[],
  ): Promise<D1QueryResult[]> {
    const response = await this.request(
      "POST",
      `${this.#d1(databaseId)}/query`,
      {
        body: this.#d1Body(statements),
        headers: { "content-type": "application/json" },
      },
    );
    return (await this.#json<D1QueryResult[]>("POST query", response)).result;
  }

  /** As {@link d1Query}, through `/raw`: rows as arrays, with the column names. */
  async d1Raw(
    databaseId: string,
    statements: readonly D1Statement[],
  ): Promise<D1RawResult[]> {
    const response = await this.request("POST", `${this.#d1(databaseId)}/raw`, {
      body: this.#d1Body(statements),
      headers: { "content-type": "application/json" },
    });
    return (await this.#json<D1RawResult[]>("POST raw", response)).result;
  }
}

/** Cloudflare's errors, as one line. */
function describeErrors(envelope: Envelope<unknown>): string {
  const errors = envelope.errors ?? [];
  if (errors.length === 0) {
    return "no error given";
  }
  return errors
    .map((error) => `${error.code ?? "?"} ${error.message ?? ""}`.trim())
    .join("; ");
}
