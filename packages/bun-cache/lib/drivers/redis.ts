/**
 * The Redis driver (plan §7.7), over Bun's built-in `RedisClient`.
 *
 * **Keys** (`<p>` is the prefix, `bun-cache` by default; `<ns>` the namespace
 * through `encodeSegment`, so a namespace never contains `}` or `:` and
 * `sweep` can read it back from a key's name; always in a hash tag, so a
 * future cluster mode keeps the layout). Glob characters in a `SCAN` pattern
 * are escaped, so no prefix or namespace matches its look-alikes:
 *
 * ```
 * <p>:{<ns>}:e:<key>   STRING  the entry frame (below), PEXPIREAT expiresAt
 * <p>:{<ns>}:n:<key>   HASH    a counter: n (value), x (expiresAt or -), c (createdAt); PEXPIREAT expiresAt
 * <p>:{<ns>}:t:<tag>   SET     the keys carrying the tag; no TTL (pruned by sweep)
 * <p>:{<ns>}:s:<tag>   STRING  the tag's stamp, "<at> <until>"; no TTL (pruned by sweep)
 * <p>:{<ns>}:l:<key>   STRING  a lock's owner, PX ttl
 * <p>:bus              CHANNEL the bus (redisBus's channel for the same prefix)
 * ```
 *
 * - **The entry frame** is `1 <expiresAt|-> <tags as JSON>\n` followed by the
 *   entry's bytes, so one `GET` answers the whole {@link StoredEntry}. Bun's
 *   client returns every reply but `getBuffer`'s as a string, which is lossy
 *   for bytes that are not UTF-8 (measured: `eval`, `send("GET")` and `mget`
 *   all mangle a 256-byte value), so values are only ever read with
 *   `getBuffer`, and no script returns one.
 * - **Atomic paths are Lua** (`EVALSHA`, falling back to `EVAL` on
 *   `NOSCRIPT`): `set` with the tag fence (check the stamps, replace the old
 *   tag memberships, write), `delete`, `deleteByTags` (stamps first, then every
 *   member, in one script), `increment` (create with its expiry, or add),
 *   `touch`, and the lock's take and compare-and-delete.
 * - **Expiry is native** (`PEXPIREAT`), so the core's sweeper never has
 *   entries to reclaim. `sweep` only prunes what carries no TTL: tag-set
 *   members whose entry is gone, empty tag sets, and lapsed stamps.
 * - **Tag sets and stamps have no Redis TTL**, a departure from §7.7. Under
 *   the `volatile-lru` policy the plan recommends for a memory cap, a TTL'd
 *   tag set or stamp could be evicted while its entries live on, and then an
 *   invalidation would miss them (a tag set) or a stale load would pass the
 *   fence (a stamp). Without a TTL, `volatile-*` never evicts them.
 * - **The bus** is `redisBus` (lib/bus/redis.ts) on this driver's client and
 *   prefix: the same channel, `<p>:bus`, the same JSON messages, a reconnect
 *   reported as a gap. A `redisBus` with the same prefix shares it.
 * - **Cluster**: Bun's `RedisClient` does not follow Redis Cluster's `MOVED`
 *   and `ASK` redirects (oven-sh/bun#22947; measured on a three-node cluster:
 *   every key on another node fails with `MOVED`). So `cluster: true` throws,
 *   and connecting to a cluster node fails, naming the issue.
 */
import { RedisClient } from "bun";
import type { RedisOptions } from "bun";
import { redisBus } from "../bus/redis";
import type {
  BusMessage,
  CacheBus,
  CacheDriver,
  CacheDriverCapabilities,
  StoredEntry,
  TagFence,
} from "../core/types";
import { encodeSegment } from "./file-names";
import type { ConnectionInput } from "./sql-connection";
import { resolveConnectionUrl } from "./sql-connection";

/** The default key prefix (§7, §21). */
export const DEFAULT_REDIS_PREFIX = "bun-cache";

/**
 * How long a connection that has never connected may take, ms, by default.
 * After bun-jobs' `FIRST_CONNECT_TIMEOUT_MS` (redis-driver.ts@c4fdaf01): Bun
 * retries a refused first connect for its whole reconnect budget (measured
 * here: 31.2 s on a refused port), so an unreachable Redis would take half a
 * minute to report. 5 s, not bun-jobs' 1 s: a managed Redis in another
 * region takes most of a second to connect over TLS (Upstash from West
 * Africa: 549–1004 ms, three round trips of ~300 ms), so 1 s refused a
 * healthy server about as often as not.
 */
const FIRST_CONNECT_TIMEOUT_MS = 5_000;

/** How many keys one `SCAN` call asks for, in `clear` and `sweep`. */
const SCAN_COUNT = 1_000;

/** The most `SCAN` calls one `sweep` makes, so a pass is bounded on a large keyspace; the next pass resumes. */
const SWEEP_SCANS = 100;

/** The issue that tracks Redis Cluster support in Bun's client. */
const CLUSTER_ISSUE = "https://github.com/oven-sh/bun/issues/22947";

/** `redisDriver()`'s options: a URL, connection fields or a client, and the key prefix. */
export interface RedisDriverOptions extends ConnectionInput {
  /**
   * An already-open `RedisClient` to run on instead of building one. Never
   * closed by the driver (§6.1), and its connection options are its own:
   * `firstConnectTimeout`, `connectionTimeout`, `maxRetries` and
   * `autoReconnect` do not apply to it. The bus subscribes on a `duplicate()`
   * of it, which the driver closes. `url`/`connection` are then ignored.
   */
  client?: RedisClient;
  /**
   * Prepended to every key (`<prefix>:{<ns>}:…`) and to the bus channel
   * (`<prefix>:bus`). Defaults to `bun-cache`. Must not be empty or contain
   * `{` or `}` (the hash tag's delimiters); anything else throws.
   */
  prefix?: string;
  /**
   * Redis Cluster. **Not supported yet**: Bun's `RedisClient` does not follow
   * `MOVED`/`ASK` redirects (oven-sh/bun#22947), so `true` throws. Point the
   * driver at a single Redis, or a primary behind a stable address. Defaults
   * to `false`.
   */
  cluster?: boolean;
  /**
   * How long the first connect may take, in ms, before it fails naming the
   * server. Defaults to `5000`; `0` removes the bound. Within it Bun still
   * retries a refusal, so a server a moment late is reached. Without it, a
   * refused port takes Bun's whole retry budget (31 s, measured) to fail.
   * Leave room for a distant server: a TLS connect is three round trips
   * (about 1 s to a managed Redis in another region, measured). Not applied
   * to a supplied `client`. After bun-jobs' Redis driver option of the same
   * name.
   */
  firstConnectTimeout?: number;
  /** Bun's `connectionTimeout` (ms per connection attempt; a timed-out attempt is not retried), passed through. Bun's default (10 s) when absent. Ignored with `client`. */
  connectionTimeout?: number;
  /** Bun's `maxRetries` for a dropped connection, passed through. Bun's default (20, about 31 s) when absent. Ignored with `client`. */
  maxRetries?: number;
  /** Bun's `autoReconnect`, passed through. Bun's default (`true`) when absent. Ignored with `client`. */
  autoReconnect?: boolean;
  /** The clock, epoch ms. Internal: for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** A Lua script with its digest, so `EVALSHA` can be tried first. */
interface Script {
  /** The source. */
  source: string;
  /** Its SHA-1, hex: what `EVALSHA` names it by. */
  sha: string;
}

/**
 * Helpers every script carries. `dropEntry` deletes one entry and its tag
 * memberships, read from the frame's header; it answers 1 when there was an
 * entry. A frame that does not parse (a foreign value at our key) is deleted
 * with no memberships to drop.
 */
const LUA_HELPERS = `
local function frameTags(frame)
  local nl = string.find(frame, '\\n', 1, true)
  if not nl then return {} end
  local tj = string.match(string.sub(frame, 1, nl - 1), '^1 %S+ (.*)$')
  if not tj then return {} end
  local ok, tags = pcall(cjson.decode, tj)
  if ok and type(tags) == 'table' then return tags end
  return {}
end
local function dropEntry(base, key)
  local ek = base .. 'e:' .. key
  local old = redis.pcall('GET', ek)
  if type(old) ~= 'string' then
    if type(old) == 'table' and old.err then redis.call('UNLINK', ek) return 1 end
    return 0
  end
  for _, tag in ipairs(frameTags(old)) do
    redis.call('SREM', base .. 't:' .. tag, key)
  end
  redis.call('UNLINK', ek)
  return 1
end
`;

/** A script from its body, with the shared helpers prepended. */
function script(body: string): Script {
  const source = `${LUA_HELPERS}\n${body}`;
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(source);
  return { source, sha: hasher.digest("hex") };
}

/**
 * `set`: KEYS[1] the entry; ARGV base, key, frame, expiresAt ('' none), now,
 * fence createdAt ('' none), then a count and the fence's tags, then a count
 * and the entry's tags. Answers 1 stored, 0 fenced.
 */
const SET = script(`
local base, key, frame, exp, now, fenceAt = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5]), ARGV[6]
local i = 7
local nf = tonumber(ARGV[i])
if fenceAt ~= '' then
  local at = tonumber(fenceAt)
  for j = 1, nf do
    local stamp = redis.call('GET', base .. 's:' .. ARGV[i + j])
    if stamp then
      local sat, suntil = string.match(stamp, '^(%S+) (%S+)$')
      if sat and tonumber(suntil) > now and tonumber(sat) >= at then return 0 end
    end
  end
end
i = i + nf + 1
local nt = tonumber(ARGV[i])
dropEntry(base, key)
redis.call('UNLINK', base .. 'n:' .. key)
local ek = base .. 'e:' .. key
redis.call('SET', ek, frame)
if exp ~= '' then redis.call('PEXPIREAT', ek, exp) end
for j = 1, nt do
  redis.call('SADD', base .. 't:' .. ARGV[i + j], key)
end
return 1
`);

/** `delete`: ARGV base, then the keys. Answers how many entries and counters went. */
const DELETE = script(`
local base = ARGV[1]
local n = 0
for i = 2, #ARGV do
  n = n + dropEntry(base, ARGV[i])
  n = n + redis.call('UNLINK', base .. 'n:' .. ARGV[i])
end
return n
`);

/**
 * `touch`: KEYS[1] the entry; ARGV base, key, expiresAt ('' none). Rewrites
 * an entry's frame header and its expiry, or a counter's; 0 when neither.
 */
const TOUCH = script(`
local base, key, exp = ARGV[1], ARGV[2], ARGV[3]
local shown = exp
if exp == '' then shown = '-' end
local ek = base .. 'e:' .. key
local frame = redis.call('GET', ek)
if frame then
  local nl = string.find(frame, '\\n', 1, true)
  local tj = nl and string.match(string.sub(frame, 1, nl - 1), '^1 %S+ (.*)$')
  if not tj then return 0 end
  redis.call('SET', ek, '1 ' .. shown .. ' ' .. tj .. string.sub(frame, nl))
  if exp ~= '' then redis.call('PEXPIREAT', ek, exp) end
  return 1
end
local nk = base .. 'n:' .. key
if redis.call('EXISTS', nk) == 1 then
  redis.call('HSET', nk, 'x', shown)
  if exp == '' then redis.call('PERSIST', nk) else redis.call('PEXPIREAT', nk, exp) end
  return 1
end
return 0
`);

/**
 * `deleteByTags`: KEYS[1] the first tag's set; ARGV base, at, until, then the
 * tags. Writes every stamp first, then deletes every member of every tag set
 * and the sets: one script, so no fenced write interleaves.
 */
const DELETE_BY_TAGS = script(`
local base, at, untl = ARGV[1], ARGV[2], ARGV[3]
for i = 4, #ARGV do
  redis.call('SET', base .. 's:' .. ARGV[i], at .. ' ' .. untl)
end
local n = 0
for i = 4, #ARGV do
  local tk = base .. 't:' .. ARGV[i]
  for _, key in ipairs(redis.call('SMEMBERS', tk)) do
    n = n + dropEntry(base, key)
  end
  redis.call('UNLINK', tk)
end
return n
`);

/**
 * `increment`: KEYS[1] the counter; ARGV base, key, by, expiresAt ('' none),
 * now. A live counter is added to; otherwise the counter is created with its
 * expiry (and an entry under the key is dropped: the last writer wins).
 */
const INCREMENT = script(`
local base, key, by, exp, now = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5]
local nk = base .. 'n:' .. key
local h = redis.call('HMGET', nk, 'n', 'x')
local lapsed = h[2] and h[2] ~= '-' and tonumber(h[2]) <= tonumber(now)
if h[1] and not lapsed then
  return redis.call('HINCRBY', nk, 'n', by)
end
dropEntry(base, key)
redis.call('UNLINK', nk)
local shown = exp
if exp == '' then shown = '-' end
redis.call('HSET', nk, 'n', by, 'x', shown, 'c', now)
if exp ~= '' then redis.call('PEXPIREAT', nk, exp) end
return tonumber(by)
`);

/** `acquireLock`: KEYS[1] the lock; ARGV owner, ttl ms. Taken when absent or already ours (a re-acquire refreshes it). */
const ACQUIRE_LOCK = script(`
local held = redis.call('GET', KEYS[1])
if held == false or held == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0
`);

/** `releaseLock`: KEYS[1] the lock; ARGV owner. Compare-and-delete. */
const RELEASE_LOCK = script(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`);

/** `sweep`, a tag set: KEYS[1] the set; ARGV base. Drops members whose entry is gone, and the set once empty. */
const PRUNE_TAG_SET = script(`
local n = 0
for _, key in ipairs(redis.call('SMEMBERS', KEYS[1])) do
  if redis.call('EXISTS', ARGV[1] .. 'e:' .. key) == 0 then
    redis.call('SREM', KEYS[1], key)
    n = n + 1
  end
end
if redis.call('SCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return n
`);

/** `sweep`, a stamp: KEYS[1] the stamp; ARGV now. Deletes it once lapsed (read and delete in one step, so a fresh stamp written meanwhile stays). */
const PRUNE_STAMP = script(`
local stamp = redis.call('GET', KEYS[1])
if not stamp then return 0 end
local untl = string.match(stamp, '^%S+ (%S+)$')
if untl and tonumber(untl) > tonumber(ARGV[1]) then return 0 end
redis.call('DEL', KEYS[1])
return 1
`);

/** Escapes Redis glob characters (`*?[]\`) so a prefix matches only itself in `SCAN … MATCH`. */
function globEscape(text: string): string {
  return text.replace(/[*?[\]\\]/g, (char) => `\\${char}`);
}

/** An epoch-ms expiry as the scripts take it: `''` for none, an integer otherwise. */
function expiryArg(expiresAt: number | null): string {
  return expiresAt === null ? "" : String(Math.ceil(expiresAt));
}

/** `host:port` from a Redis URL, without credentials; `redis` if it cannot be parsed. After bun-jobs' `redisEndpoint`. */
function redisEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "6379"}`;
  } catch {
    return "redis";
  }
}

/** The message `cluster: true`, and a connection to a cluster node, fail with. */
function clusterUnsupported(what: string): string {
  return `${what}: Redis Cluster is not supported yet. Bun's RedisClient does not follow the cluster's MOVED and ASK redirects (${CLUSTER_ISSUE}), so a key on another node would fail. Point the driver at a single Redis, or a primary behind a stable address.`;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** The Redis driver. See the module header and {@link RedisDriverOptions}. */
export class RedisCacheDriver implements CacheDriver {
  /** `"redis"`. */
  readonly name = "redis";
  /** Everything atomic, native expiry, a pushed bus (§7.10). */
  readonly capabilities: CacheDriverCapabilities = {
    multiProcess: true,
    ttl: "native",
    atomicIncrement: true,
    lock: true,
    tags: "index",
    fence: "atomic",
    bus: "push",
    // A Redis string holds 512 MB; a MiB is left for the frame's header.
    maxEntryBytes: 511 * 1024 * 1024,
  };

  /** The key prefix, as resolved. Internal; read by the tests. */
  readonly prefix: string;
  /** The client every command runs on. */
  readonly #client: RedisClient;
  /** Whether the client is the driver's own, so `close()` closes it. */
  readonly #ownsClient: boolean;
  /** The bus: `redisBus` on this client and prefix. Internal; read by the tests (its subscriber's connection name). */
  readonly bus: CacheBus;
  /** The clock. */
  readonly #now: () => number;
  /** The first-connect bound, ms; `0` is none. */
  readonly #firstConnectTimeout: number;
  /** `host:port`, for connect errors. */
  readonly #endpoint: string;
  /** The connect in flight, shared; cleared when it settles. */
  #connecting: Promise<void> | undefined;
  /** Whether the client has connected once (and passed the cluster check). */
  #everConnected = false;
  /** Set once `close()` ran. */
  #closed = false;
  /** Where the next `sweep` resumes its `SCAN`. */
  #sweepCursor = "0";

  constructor(
    /** The options: a URL, connection fields or a client. */ options: RedisDriverOptions,
  ) {
    if (options.cluster === true) {
      throw new TypeError(clusterUnsupported("redisDriver"));
    }
    const prefix = options.prefix ?? DEFAULT_REDIS_PREFIX;
    if (prefix === "" || /[{}]/.test(prefix)) {
      throw new TypeError(
        `redisDriver: prefix must not be empty or contain { or }; got ${JSON.stringify(prefix)}`,
      );
    }
    this.prefix = prefix;
    const firstConnectTimeout =
      options.firstConnectTimeout ?? FIRST_CONNECT_TIMEOUT_MS;
    if (!Number.isFinite(firstConnectTimeout) || firstConnectTimeout < 0) {
      throw new TypeError(
        `redisDriver: firstConnectTimeout must be a number of ms, or 0; got ${String(firstConnectTimeout)}`,
      );
    }
    this.#firstConnectTimeout = firstConnectTimeout;
    this.#now = options.now ?? Date.now;
    this.#ownsClient = options.client === undefined;
    if (options.client !== undefined) {
      this.#client = options.client;
      this.#endpoint = "redis";
    } else {
      const url = resolveConnectionUrl(
        options,
        { scheme: "redis", tlsScheme: "rediss", host: "127.0.0.1", port: 6379 },
        "redisDriver",
      );
      this.#endpoint = redisEndpoint(url);
      this.#client = new RedisClient(
        url,
        RedisCacheDriver.#clientOptions(options),
      );
    }
    this.bus = redisBus({ client: this.#client, prefix });
  }

  /** The options the driver builds its own client with: only those given, so the rest keep Bun's defaults. */
  static #clientOptions(options: RedisDriverOptions): RedisOptions {
    const out: RedisOptions = {};
    if (options.connectionTimeout !== undefined) {
      out.connectionTimeout = options.connectionTimeout;
    }
    if (options.maxRetries !== undefined) {
      out.maxRetries = options.maxRetries;
    }
    if (options.autoReconnect !== undefined) {
      out.autoReconnect = options.autoReconnect;
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Connects, or waits for the connect in flight. The first connect of an
   * owned client is bounded by `firstConnectTimeout`, and checks the server
   * is not a cluster node. Later, it brings an owned client back once Bun has
   * given up reconnecting (every operation calls it; a live connection costs
   * a property read). After bun-jobs' `RedisDriver.connect`.
   */
  async connect(): Promise<void> {
    if (this.#connecting === undefined && this.#everConnected) {
      if (!this.#ownsClient || this.#closed || this.#client.connected) {
        return;
      }
    }
    this.#connecting ??= this.#connectOnce().finally(() => {
      this.#connecting = undefined;
    });
    await this.#connecting;
  }

  /** The body of {@link connect}. */
  async #connectOnce(): Promise<void> {
    const first = !this.#everConnected;
    if (first && this.#ownsClient) {
      await this.#connectFirst();
    } else {
      try {
        await this.#client.connect();
      } catch (error) {
        throw this.#connectError(error);
      }
    }
    if (first) {
      await this.#refuseCluster();
    }
    this.#everConnected = true;
  }

  /** Connects an owned client within the first-connect budget; on failure closes it (stopping Bun's retries) and throws naming the server. */
  async #connectFirst(): Promise<void> {
    const ms = this.#firstConnectTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      if (ms > 0) {
        timer = setTimeout(() => {
          reject(
            new Error(`no connection to ${this.#endpoint} within ${ms}ms`),
          );
        }, ms);
      }
    });
    expired.catch(() => {});
    try {
      const attempt = this.#client.connect();
      attempt.catch(() => {});
      await Promise.race([attempt, expired]);
    } catch (error) {
      this.#client.close();
      throw this.#connectError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fails when the server is a Redis Cluster node (see the module header). A server that will not answer `INFO` is let through. */
  async #refuseCluster(): Promise<void> {
    let info: unknown;
    try {
      info = await this.#client.send("INFO", ["cluster"]);
    } catch {
      return;
    }
    if (typeof info === "string" && /^cluster_enabled:1\s*$/m.test(info)) {
      throw new Error(clusterUnsupported(`redisDriver (${this.#endpoint})`));
    }
  }

  /** A connect failure as an error naming the server (Bun's own says only "Connection closed"). Wraps once. */
  #connectError(error: unknown): Error {
    const prefix = `no connection to ${this.#endpoint}`;
    const message = error instanceof Error ? error.message : String(error);
    return message.startsWith(prefix) && error instanceof Error
      ? error
      : new Error(`${prefix}: ${message}`, { cause: error });
  }

  /** Awaits the connection before a command. */
  async #ready(): Promise<void> {
    if (this.#closed) {
      throw new Error("the redis cache driver is closed");
    }
    await this.connect();
  }

  /** Closes the bus, then the client when it is the driver's own. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.bus.close();
    if (this.#ownsClient) {
      this.#client.close();
    }
  }

  /** One round trip. */
  async ping(): Promise<void> {
    await this.#ready();
    await this.#client.send("PING", []);
  }

  /* ---------------------------------------------------------------- */
  /* keys and scripts                                                  */
  /* ---------------------------------------------------------------- */

  /** A namespace's key base: `<prefix>:{<encoded ns>}:`. */
  #base(ns: string): string {
    return `${this.prefix}:{${encodeSegment(ns)}}:`;
  }

  /**
   * Runs a script by its digest, sending the source only when the server
   * does not have it (`NOSCRIPT`: a restart, a `SCRIPT FLUSH`); `EVAL` caches
   * it again. After bun-jobs' `RedisDriver.#run` (redis-driver.ts@c4fdaf01),
   * with the digest computed here rather than read back from `SCRIPT LOAD`.
   * An argument may be bytes: Bun sends a `Uint8Array` as is (measured).
   */
  async #run(
    which: Script,
    keys: readonly string[],
    args: readonly (string | Uint8Array)[],
  ): Promise<unknown> {
    // Bun's declarations say `string | number`; its client also takes a
    // `Uint8Array` and sends the bytes unchanged (measured, PR-C5).
    const rest = [...keys, ...args] as unknown as string[];
    try {
      return await this.#client.evalsha(which.sha, keys.length, ...rest);
    } catch (error) {
      if (!/NOSCRIPT/i.test(error instanceof Error ? error.message : "")) {
        throw error;
      }
    }
    return await this.#client.eval(which.source, keys.length, ...rest);
  }

  /** Builds an entry's frame: `1 <expiresAt|-> <tags JSON>\n` + the bytes. */
  static #frame(entry: StoredEntry): Uint8Array {
    const header = ENCODER.encode(
      `1 ${entry.expiresAt === null ? "-" : String(entry.expiresAt)} ${JSON.stringify(entry.tags)}\n`,
    );
    const out = new Uint8Array(header.byteLength + entry.value.byteLength);
    out.set(header, 0);
    out.set(entry.value, header.byteLength);
    return out;
  }

  /** Reads a frame back; `undefined` for one that does not parse (not ours) or has expired by this clock. */
  #parse(key: string, frame: Uint8Array | null): StoredEntry | undefined {
    if (frame === null) {
      return undefined;
    }
    const newline = frame.indexOf(10);
    if (newline === -1) {
      return undefined;
    }
    const match = /^1 (\S+) (.*)$/s.exec(
      DECODER.decode(frame.subarray(0, newline)),
    );
    if (match === null) {
      return undefined;
    }
    const expiresAt = match[1] === "-" ? null : Number(match[1]);
    if (expiresAt !== null && expiresAt <= this.#now()) {
      return undefined;
    }
    let tags: string[];
    try {
      tags = JSON.parse(match[2]) as string[];
    } catch {
      return undefined;
    }
    return {
      key,
      // A view over the client's Buffer: the contract's type, no Buffer
      // methods leaking to a caller comparing bytes.
      value: new Uint8Array(
        frame.buffer,
        frame.byteOffset + newline + 1,
        frame.byteLength - newline - 1,
      ),
      expiresAt,
      tags,
    };
  }

  /* ---------------------------------------------------------------- */
  /* entries                                                           */
  /* ---------------------------------------------------------------- */

  async get(ns: string, key: string): Promise<StoredEntry | undefined> {
    await this.#ready();
    return this.#parse(
      key,
      await this.#client.getBuffer(`${this.#base(ns)}e:${key}`),
    );
  }

  async getMany(
    ns: string,
    keys: readonly string[],
  ): Promise<(StoredEntry | undefined)[]> {
    if (keys.length === 0) {
      return [];
    }
    await this.#ready();
    const base = this.#base(ns);
    // Bun pipelines concurrent commands on the one connection.
    const frames = await Promise.all(
      keys.map(async (key) => await this.#client.getBuffer(`${base}e:${key}`)),
    );
    return keys.map((key, index) => this.#parse(key, frames[index]));
  }

  async set(
    ns: string,
    entry: StoredEntry,
    fence?: TagFence,
  ): Promise<"stored" | "fenced"> {
    await this.#ready();
    const base = this.#base(ns);
    const fencing = fence !== undefined && fence.tags.length > 0;
    const fenceTags = fencing ? [...new Set(fence.tags)] : [];
    const tags = [...new Set(entry.tags)];
    const stored = await this.#run(
      SET,
      [`${base}e:${entry.key}`],
      [
        base,
        entry.key,
        RedisCacheDriver.#frame(entry),
        expiryArg(entry.expiresAt),
        String(this.#now()),
        fencing ? String(fence.createdAt) : "",
        String(fenceTags.length),
        ...fenceTags,
        String(tags.length),
        ...tags,
      ],
    );
    return stored === 1 ? "stored" : "fenced";
  }

  /** Writes several entries, pipelined (no fence: bulk writes come from `setMany`, not from loads). */
  async setMany(ns: string, entries: readonly StoredEntry[]): Promise<void> {
    await Promise.all(entries.map(async (entry) => await this.set(ns, entry)));
  }

  async delete(ns: string, keys: readonly string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    await this.#ready();
    const base = this.#base(ns);
    return Number(
      await this.#run(DELETE, [`${base}e:${keys[0]}`], [base, ...keys]),
    );
  }

  /**
   * Deletes the namespace's entries, counters and tag sets by `SCAN … MATCH`
   * in batches, so it is not atomic: a write landing during the scan may
   * survive it. Stamps and locks stay (as on the SQL drivers): a stamp still
   * fences the loads that began before its invalidation.
   */
  async clear(ns: string): Promise<void> {
    await this.#ready();
    const base = this.#base(ns);
    const pattern = `${globEscape(base)}*`;
    let cursor = "0";
    do {
      const [next, found] = await this.#client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        SCAN_COUNT,
      );
      cursor = String(next);
      const doomed = found.filter((key) => {
        const kind = key.slice(base.length, base.length + 2);
        return kind === "e:" || kind === "n:" || kind === "t:";
      });
      if (doomed.length > 0) {
        await this.#client.unlink(...doomed);
      }
    } while (cursor !== "0");
  }

  async touch(
    ns: string,
    key: string,
    expiresAt: number | null,
  ): Promise<boolean> {
    await this.#ready();
    const base = this.#base(ns);
    return (
      (await this.#run(
        TOUCH,
        [`${base}e:${key}`],
        [base, key, expiryArg(expiresAt)],
      )) === 1
    );
  }

  /* ---------------------------------------------------------------- */
  /* tags                                                              */
  /* ---------------------------------------------------------------- */

  async deleteByTags(
    ns: string,
    tags: readonly string[],
    stampUntil: number,
  ): Promise<number> {
    if (tags.length === 0) {
      return 0;
    }
    await this.#ready();
    const base = this.#base(ns);
    const distinct = [...new Set(tags)];
    return Number(
      await this.#run(
        DELETE_BY_TAGS,
        [`${base}t:${distinct[0]}`],
        [base, String(this.#now()), String(stampUntil), ...distinct],
      ),
    );
  }

  async getStamps(
    ns: string,
    tags: readonly string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (tags.length === 0) {
      return out;
    }
    await this.#ready();
    const base = this.#base(ns);
    const distinct = [...new Set(tags)];
    // Stamps are ASCII ("<at> <until>"), so the string reply is exact.
    const values = await this.#client.mget(
      ...distinct.map((tag) => `${base}s:${tag}`),
    );
    const now = this.#now();
    distinct.forEach((tag, index) => {
      const match = /^(\S+) (\S+)$/.exec(values[index] ?? "");
      if (match !== null && Number(match[2]) > now) {
        out.set(tag, Number(match[1]));
      }
    });
    return out;
  }

  async setStamps(
    ns: string,
    tags: readonly string[],
    at: number,
    until: number,
  ): Promise<void> {
    if (tags.length === 0) {
      return;
    }
    await this.#ready();
    const base = this.#base(ns);
    await this.#client.mset(
      ...[...new Set(tags)].flatMap((tag) => [
        `${base}s:${tag}`,
        `${at} ${until}`,
      ]),
    );
  }

  /* ---------------------------------------------------------------- */
  /* counters and locks                                                */
  /* ---------------------------------------------------------------- */

  async increment(
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ): Promise<number> {
    if (!Number.isSafeInteger(by)) {
      throw new TypeError(
        `Redis cache counters are integers (HINCRBY); cannot add ${by}`,
      );
    }
    await this.#ready();
    const base = this.#base(ns);
    return Number(
      await this.#run(
        INCREMENT,
        [`${base}n:${key}`],
        [base, key, String(by), expiryArg(expiresAt), String(this.#now())],
      ),
    );
  }

  async getCounter(
    ns: string,
    key: string,
  ): Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  > {
    await this.#ready();
    const [n, x, c] = await this.#client.hmget(
      `${this.#base(ns)}n:${key}`,
      "n",
      "x",
      "c",
    );
    if (n === null || n === undefined) {
      return undefined;
    }
    const expiresAt =
      x === null || x === undefined || x === "-" ? null : Number(x);
    if (expiresAt !== null && expiresAt <= this.#now()) {
      return undefined;
    }
    return { value: Number(n), expiresAt, createdAt: Number(c ?? 0) };
  }

  async acquireLock(
    ns: string,
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    await this.#ready();
    return (
      (await this.#run(
        ACQUIRE_LOCK,
        [`${this.#base(ns)}l:${key}`],
        [owner, String(Math.max(1, Math.ceil(ttlMs)))],
      )) === 1
    );
  }

  async releaseLock(ns: string, key: string, owner: string): Promise<boolean> {
    await this.#ready();
    return (
      (await this.#run(
        RELEASE_LOCK,
        [`${this.#base(ns)}l:${key}`],
        [owner],
      )) === 1
    );
  }

  /* ---------------------------------------------------------------- */
  /* sweep                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Prunes what has no TTL (see the module header): tag-set members whose
   * entry expired or was evicted, then the empty sets, and lapsed stamps.
   * Entries and counters expire natively, so nothing here reclaims them.
   * Walks the prefix's keys with `SCAN`, at most {@link SWEEP_SCANS} calls a
   * pass and until `limit` keys were pruned; the next pass resumes where this
   * one stopped. Answers how many members and stamps went.
   */
  async sweep(now: number, limit: number): Promise<number> {
    await this.#ready();
    const pattern = `${globEscape(this.prefix)}:{*`;
    const head = `${this.prefix}:{`;
    let pruned = 0;
    for (let calls = 0; calls < SWEEP_SCANS && pruned < limit; calls++) {
      const [next, found] = await this.#client.scan(
        this.#sweepCursor,
        "MATCH",
        pattern,
        "COUNT",
        SCAN_COUNT,
      );
      this.#sweepCursor = String(next);
      for (const key of found) {
        // `<prefix>:{<ns>}:<kind>:…`; the encoded namespace holds no `}`.
        const close = key.indexOf("}:", head.length);
        if (!key.startsWith(head) || close === -1) {
          continue;
        }
        const base = key.slice(0, close + 2);
        const kind = key.slice(close + 2, close + 4);
        if (kind === "t:") {
          pruned += Number(await this.#run(PRUNE_TAG_SET, [key], [base]));
        } else if (kind === "s:") {
          pruned += Number(await this.#run(PRUNE_STAMP, [key], [String(now)]));
        }
      }
      if (this.#sweepCursor === "0") {
        break;
      }
    }
    return pruned;
  }

  /* ---------------------------------------------------------------- */
  /* the bus (§4.2): redisBus on this client                           */
  /* ---------------------------------------------------------------- */

  async publish(message: BusMessage): Promise<void> {
    await this.#ready();
    await this.bus.publish(message);
  }

  async subscribe(
    onMessage: (message: BusMessage) => void,
    onGap: () => void,
  ): Promise<() => Promise<void>> {
    await this.#ready();
    return await this.bus.subscribe(onMessage, onGap);
  }
}

/** A Redis driver (§7.7) over Bun's `RedisClient`. See {@link RedisCacheDriver} and {@link RedisDriverOptions}. */
export function redisDriver(options: RedisDriverOptions): CacheDriver {
  return new RedisCacheDriver(options);
}
