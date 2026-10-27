/**
 * The file driver (plan §7.2): one directory, one file per entry, on a POSIX
 * local filesystem (never NFS).
 *
 * **Layout** (the default prefix is `bun-cache`):
 *
 * ```
 * <root>/<seg ns>/e/<hh>/<sha256(key)>.bce   entry: file header + core bytes
 * <root>/<seg ns>/s/<sha256(tag)>            tag stamp (JSON { at, until })
 * <root>/<seg ns>/n/<sha256(key)>.cnt        counter (JSON { value, expiresAt, createdAt })
 * <root>/<seg ns>/l/<sha256(key)>.lock       per-key lock file (JSON { owner, expiresAt })
 * <root>/bus.log                             append-only bus log
 * ```
 *
 * `seg` is the case-proof `encodeSegment` (copied from bun-jobs, see
 * `file-names.ts`). `hh` is the first byte of the key's SHA-256 as two hex
 * characters — one level of 256 directories, so a million keys stay under
 * ~4,000 entries per directory. `shard: 0 | 1 | 2` flattens or deepens it.
 *
 * **Atomic writes.** Every entry is written to
 * `<path>.<pid>.<uuid>.tmp` and renamed into place: a reader never sees a
 * torn entry. **Locks** are `O_EXCL` lock files, stale after their TTL and
 * broken by renaming them aside (bun-jobs' `#lockFile` pattern), so a dead
 * holder's lock lapses and a live one is never stolen. **Counters and lock
 * operations run under the per-key lock file.**
 *
 * **Tags** are `stamps` mode (§3.6): `invalidateTags` writes one stamp file
 * per tag, the core's read-side check invalidates, and the sweeper reclaims
 * the dead entries. An eager marker index was considered and declined in the
 * plan: one extra file per tag per entry, and a crash between marker and
 * entry leaves debris.
 *
 * **Expiry** is lazy on read (an expired file is unlinked, not returned) plus
 * the sweeper, which reads only the 14-byte file header to decide. `maxBytes`
 * and `maxEntries` evict oldest first by modification time — age order, not
 * LRU: recording each read would cost a write per read.
 */
import { Buffer } from "node:buffer";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import type {
  BusMessage,
  CacheDriver,
  CacheDriverCapabilities,
  SchemaChange,
  SchemaSyncOptions,
  StoredEntry,
  TagFence,
} from "../core/types";
import { encodeSegment } from "./file-names";

/** The entry file's magic and format version. */
const FILE_MAGIC = [0x42, 0x46]; // "BF"

/** The entry file format's version byte. */
const FILE_FORMAT = 1;

/** The fixed part of the entry header: magic, format, reserved, expiresAt f64, tag count u16. */
const FILE_HEADER_LENGTH = 2 + 1 + 1 + 8 + 2;

/** The sentinel for "no expiry" in the file header's `expiresAt` slot. */
const NO_EXPIRY = -1;

/** The default bus-log cap: past it, a publish compacts the log to its tail. */
const DEFAULT_MAX_BUS_LOG_BYTES = 1024 * 1024;

/** The default bus poll interval (§4.2). */
const DEFAULT_BUS_POLL_INTERVAL_MS = 250;

/** `fileDriver()`'s options. */
export interface FileDriverOptions {
  /** The root directory everything lives under. Created on first write. */
  root: string;
  /** Sharding depth under `e/`: 0 = flat, 1 = 256 directories (the default), 2 = 65,536. */
  shard?: 0 | 1 | 2;
  /** At most this many entries; oldest by modification time go first, enforced by the sweeper. Uncapped by default. */
  maxEntries?: number;
  /** At most this many encoded bytes; oldest by modification time go first. Uncapped by default. */
  maxBytes?: number;
  /** The bus log's poll interval, in ms. Defaults to 250 (§4.2). */
  busPollInterval?: number;
  /** The bus log's cap, in bytes; a publish past it compacts the log (subscribers see a gap and flush). Defaults to 1 MiB. */
  maxBusLogBytes?: number;
  /** The clock, epoch ms. Internal: for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** One stamp file's content. */
interface StampFile {
  /** When the tag was invalidated, epoch ms. */
  at: number;
  /** When the stamp itself expires, epoch ms. */
  until: number;
}

/** One counter file's content. */
interface CounterFile {
  /** The current value. */
  value: number;
  /** The hard expiry, epoch ms, set at creation only; `null` never expires. */
  expiresAt: number | null;
  /** When the counter was created, epoch ms. */
  createdAt: number;
}

/** One lock file's content. */
interface LockFile {
  /** Who holds it. */
  owner: string;
  /** When it lapses, epoch ms. */
  expiresAt: number;
}

/** Hashes a name (a key or a tag) for its file name. */
function hash(name: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(name);
  return hasher.digest("hex");
}

/** Encodes one entry file: the driver header, then the core's opaque bytes. */
function encodeEntryFile(entry: StoredEntry): Uint8Array {
  const tags = entry.tags.map((tag) => new TextEncoder().encode(tag));
  const tagsLength = tags.reduce((total, tag) => total + 2 + tag.length, 0);
  const out = new Uint8Array(
    FILE_HEADER_LENGTH + tagsLength + entry.value.length,
  );
  const view = new DataView(out.buffer);
  out[0] = FILE_MAGIC[0];
  out[1] = FILE_MAGIC[1];
  out[2] = FILE_FORMAT;
  out[3] = 0;
  view.setFloat64(4, entry.expiresAt ?? NO_EXPIRY, true);
  view.setUint16(12, tags.length, true);
  let offset = FILE_HEADER_LENGTH;
  for (const tag of tags) {
    view.setUint16(offset, tag.length, true);
    out.set(tag, offset + 2);
    offset += 2 + tag.length;
  }
  out.set(entry.value, offset);
  return out;
}

/** Whether the file at `path` is past its expiry, from the first FILE_HEADER_LENGTH bytes; `undefined` when it is not an entry file. */
async function readExpiry(path: string): Promise<number | null | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const head = new Uint8Array(FILE_HEADER_LENGTH);
    const { bytesRead } = await handle.read(head, 0, FILE_HEADER_LENGTH, 0);
    if (
      bytesRead < FILE_HEADER_LENGTH ||
      head[0] !== FILE_MAGIC[0] ||
      head[1] !== FILE_MAGIC[1]
    ) {
      return undefined;
    }
    const expiresAt = new DataView(head.buffer).getFloat64(4, true);
    return expiresAt === NO_EXPIRY ? null : expiresAt;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** The file driver. See the module header. */
class FileDriver implements CacheDriver {
  /** `"file"`. */
  readonly name = "file";

  /** What a POSIX filesystem can do atomically: file locks, and increments under them; no tag index. */
  readonly capabilities: CacheDriverCapabilities = {
    multiProcess: true,
    ttl: "sweep",
    atomicIncrement: true,
    lock: true,
    tags: "stamps",
    fence: "atomic",
    bus: "poll",
  };

  readonly #options: Required<
    Pick<FileDriverOptions, "root" | "busPollInterval" | "maxBusLogBytes">
  > &
    FileDriverOptions;

  /** The clock (the `now` option, or `Date.now`). */
  readonly #now: () => number;

  /** Open bus pollers, stopped by `close()`. */
  readonly #pollers = new Set<ReturnType<typeof setInterval>>();

  /** Directories already made, so writes do not re-mkdir on every operation. */
  readonly #madeDirs = new Map<string, Promise<void>>();

  constructor(
    /** The options; `root` is required. */ options: FileDriverOptions,
  ) {
    if (typeof options.root !== "string" || options.root === "") {
      throw new TypeError("fileDriver: a root directory is required");
    }
    this.#options = {
      busPollInterval: DEFAULT_BUS_POLL_INTERVAL_MS,
      maxBusLogBytes: DEFAULT_MAX_BUS_LOG_BYTES,
      ...options,
    };
    this.#now = options.now ?? Date.now;
  }

  /** There is nothing to connect; the root is made on first write. */
  connect(): Promise<void> {
    return Promise.resolve();
  }

  /** Stops the bus pollers. Files stay: the store is the point. */
  async close(): Promise<void> {
    for (const poller of this.#pollers) {
      clearInterval(poller);
    }
    this.#pollers.clear();
  }

  /** The root answers whether it is reachable. */
  async ping(): Promise<void> {
    await mkdir(this.#options.root, { recursive: true });
  }

  /* ---------------------------------------------------------------- */
  /* paths                                                             */
  /* ---------------------------------------------------------------- */

  /** The namespace's directory. */
  #nsDir(ns: string): string {
    return join(this.#options.root, encodeSegment(ns));
  }

  /** The entry file for a key, with its shard level. */
  #entryPath(ns: string, key: string): string {
    const hashed = hash(key);
    const shard = this.#options.shard ?? 1;
    const parts = [this.#nsDir(ns), "e"];
    if (shard >= 1) {
      parts.push(hashed.slice(0, 2));
    }
    if (shard >= 2) {
      parts.push(hashed.slice(2, 4));
    }
    return join(...parts, `${hashed}.bce`);
  }

  /** The stamp file for a tag. */
  #stampPath(ns: string, tag: string): string {
    return join(this.#nsDir(ns), "s", hash(tag));
  }

  /** The counter file for a key. */
  #counterPath(ns: string, key: string): string {
    return join(this.#nsDir(ns), "n", `${hash(key)}.cnt`);
  }

  /** The lock file for a key (or another named lock). */
  #lockPath(ns: string, key: string): string {
    return join(this.#nsDir(ns), "l", `${hash(key)}.lock`);
  }

  /** The bus log. */
  #busPath(): string {
    return join(this.#options.root, "bus.log");
  }

  /** The bus's append lock. */
  #busLockPath(): string {
    return join(this.#options.root, "bus.lock");
  }

  /* ---------------------------------------------------------------- */
  /* small fs pieces                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Writes via a temp file and a rename, so a reader never sees a partial
   * file. The rename stays inside the entry's own directory.
   */
  async #writeAtomic(
    path: string,
    contents: Uint8Array | string,
  ): Promise<void> {
    const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temp, contents);
      await rename(temp, path);
    } catch (error) {
      // Best effort: the temp may never have been created, and cleaning it
      // must not mask the error that explains the failure.
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Makes a directory once, however many callers ask at the same time. */
  #ensureDir(dir: string): Promise<void> {
    let made = this.#madeDirs.get(dir);
    if (made === undefined) {
      made = mkdir(dir, { recursive: true }).then(() => undefined);
      this.#madeDirs.set(dir, made);
    }
    return made;
  }

  /**
   * Creates `path` only if absent, with its full content, atomically: the
   * content is written to a temp file and *linked* into place — `link(2)`
   * fails with EEXIST if the path is taken. A `wx` write is not enough: a
   * concurrent reader can open the new file between its creation and the
   * write's flush, read it as empty, and judge the lock broken (measured:
   * ~2% of contenders under a 2×100-process herd).
   */
  async #createExclusive(path: string, contents: string): Promise<boolean> {
    await this.#ensureDir(dirname(path));
    const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temp, contents);
      await link(temp, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  /** Reads a JSON file; `undefined` when missing or unparseable. */
  async #readJson<T>(path: string): Promise<T | undefined> {
    try {
      const text = await readFile(path, "utf8");
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- */
  /* entries                                                           */
  /* ---------------------------------------------------------------- */

  async get(ns: string, key: string): Promise<StoredEntry | undefined> {
    const path = this.#entryPath(ns, key);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch {
      return undefined;
    }
    if (
      bytes.length < FILE_HEADER_LENGTH ||
      bytes[0] !== FILE_MAGIC[0] ||
      bytes[1] !== FILE_MAGIC[1] ||
      bytes[2] !== FILE_FORMAT
    ) {
      return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const expiresAt = view.getFloat64(4, true);
    if (expiresAt !== NO_EXPIRY && expiresAt <= this.#now()) {
      // Lazy expiry: reclaim on read (§7.2).
      await unlink(path).catch(() => undefined);
      return undefined;
    }
    const tagCount = view.getUint16(12, true);
    let offset = FILE_HEADER_LENGTH;
    const tags: string[] = [];
    const decoder = new TextDecoder();
    for (let index = 0; index < tagCount; index++) {
      if (offset + 2 > bytes.length) {
        return undefined;
      }
      const length = view.getUint16(offset, true);
      tags.push(
        decoder.decode(bytes.subarray(offset + 2, offset + 2 + length)),
      );
      offset += 2 + length;
    }
    if (offset > bytes.length) {
      return undefined;
    }
    return {
      key,
      value: bytes.slice(offset),
      expiresAt: expiresAt === NO_EXPIRY ? null : expiresAt,
      tags,
    };
  }

  async getMany(
    ns: string,
    keys: readonly string[],
  ): Promise<(StoredEntry | undefined)[]> {
    return await Promise.all(keys.map(async (key) => await this.get(ns, key)));
  }

  async set(
    ns: string,
    entry: StoredEntry,
    fence?: TagFence,
  ): Promise<"stored" | "fenced"> {
    // Stamps mode (§3.6): no write fence — the read-side check sees a stamp
    // whatever order the writes landed in.
    void fence;
    const path = this.#entryPath(ns, entry.key);
    await this.#ensureDir(dirname(path));
    // A counter and an entry never share a key: the last writer wins.
    await unlink(this.#counterPath(ns, entry.key)).catch(() => undefined);
    await this.#writeAtomic(path, encodeEntryFile(entry));
    return "stored";
  }

  async setMany(ns: string, entries: readonly StoredEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.set(ns, entry);
    }
  }

  async delete(ns: string, keys: readonly string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      const removed = await unlink(this.#entryPath(ns, key))
        .then(() => true)
        .catch(() => false);
      if (removed) {
        count++;
      }
      if (
        await unlink(this.#counterPath(ns, key))
          .then(() => true)
          .catch(() => false)
      ) {
        count++;
      }
    }
    return count;
  }

  async clear(ns: string): Promise<void> {
    await rm(this.#nsDir(ns), { recursive: true, force: true });
  }

  async touch(
    ns: string,
    key: string,
    expiresAt: number | null,
  ): Promise<boolean> {
    const path = this.#entryPath(ns, key);
    try {
      const bytes = await readFile(path);
      if (bytes.length < FILE_HEADER_LENGTH) {
        return false;
      }
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat64(
        4,
        expiresAt ?? NO_EXPIRY,
        true,
      );
      await this.#writeAtomic(path, bytes);
      return true;
    } catch {
      // Not an entry — maybe a counter.
    }
    const counterPath = this.#counterPath(ns, key);
    const counter = await this.#readJson<CounterFile>(counterPath);
    if (counter === undefined) {
      return false;
    }
    counter.expiresAt = expiresAt;
    await this.#writeAtomic(counterPath, JSON.stringify(counter));
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* stamps (tags: "stamps", §3.6)                                     */
  /* ---------------------------------------------------------------- */

  async getStamps(
    ns: string,
    tags: readonly string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const now = this.#now();
    for (const tag of tags) {
      const path = this.#stampPath(ns, tag);
      const stamp = await this.#readJson<StampFile>(path);
      if (stamp === undefined) {
        continue;
      }
      if (stamp.until <= now) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      out.set(tag, stamp.at);
    }
    return out;
  }

  async setStamps(
    ns: string,
    tags: readonly string[],
    at: number,
    until: number,
  ): Promise<void> {
    for (const tag of tags) {
      const path = this.#stampPath(ns, tag);
      await this.#ensureDir(dirname(path));
      const stamp: StampFile = { at, until };
      await this.#writeAtomic(path, JSON.stringify(stamp));
    }
  }

  /* ---------------------------------------------------------------- */
  /* counters (§3.8: read, add and write under the per-key lock file)  */
  /* ---------------------------------------------------------------- */

  async increment(
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ): Promise<number> {
    const release = await this.#holdKeyLock(ns, key);
    try {
      const path = this.#counterPath(ns, key);
      const now = this.#now();
      let counter = await this.#readJson<CounterFile>(path);
      if (
        counter !== undefined &&
        counter.expiresAt !== null &&
        counter.expiresAt <= now
      ) {
        counter = undefined;
      }
      if (counter === undefined) {
        counter = { value: 0, expiresAt, createdAt: now };
      }
      counter.value += by;
      await this.#writeAtomic(path, JSON.stringify(counter));
      return counter.value;
    } finally {
      await release();
    }
  }

  async getCounter(
    ns: string,
    key: string,
  ): Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  > {
    const counter = await this.#readJson<CounterFile>(
      this.#counterPath(ns, key),
    );
    if (counter === undefined) {
      return undefined;
    }
    if (counter.expiresAt !== null && counter.expiresAt <= this.#now()) {
      await unlink(this.#counterPath(ns, key)).catch(() => undefined);
      return undefined;
    }
    return counter;
  }

  /* ---------------------------------------------------------------- */
  /* locks (O_EXCL files, stale after their TTL)                       */
  /* ---------------------------------------------------------------- */

  /**
   * Takes the per-key lock for a counter update, waiting out a live holder's
   * TTL. Distinct from `acquireLock`: here the waiter wins eventually,
   * because a counter must not be lost.
   *
   * The lock's TTL is 10 s, deliberately far above the op it guards (a
   * read-modify-write of one small file — milliseconds even loaded). The
   * stale-break's judgment is a read-then-rename: judge a live lock stale by
   * mistake and the rename moves it aside, freeing the path for a second
   * holder while the first still works (the herd race this whole scheme is
   * built around; `#stealStale` limits the blast radius but cannot close the
   * window). A TTL no op can legitimately outlive means a live lock is never
   * judged stale: the break only ever fires on a genuinely dead holder,
   * which is exactly what the 10 s is for. Measured: 500 ms re-opened the
   * race ~once per 2,000 increments under a 200-way herd; 10 s does not.
   */
  async #holdKeyLock(ns: string, key: string): Promise<() => Promise<void>> {
    const owner = `counter:${process.pid}:${crypto.randomUUID()}`;
    for (let attempt = 0; ; attempt++) {
      if (await this.acquireLock(ns, key, owner, 10_000)) {
        return async () => {
          await this.releaseLock(ns, key, owner);
        };
      }
      // Backoff with jitter: hundreds of contenders on one key must thin
      // out, not retry in lockstep (measured: a fixed 5 ms retry is
      // quadratic on two processes).
      await Bun.sleep(Math.min(2 * 1.5 ** attempt, 50) * (0.5 + Math.random()));
    }
  }

  /**
   * Decides what a failed create found at `path`: a live lock (`"held"`), a
   * positively stale one to break (`"stale"`), or no lock at all (`"free"`).
   *
   * Only a *positively read* lock file with a lapsed `expiresAt` is ever
   * judged stale — anything else is either live or gone, never moved. The
   * rule exists because a misjudged stale-break moves a live lock aside and
   * frees the path for a second holder (the herd's double-hold, measured):
   *
   * - **Readable and unexpired** → live, plainly.
   * - **Readable and expired** → stale, plainly.
   * - **Unreadable** → *never* judged stale. Under a herd, a `readFile`
   *   races the holder's release and the next holder's create: an ENOENT is
   *   the gap between them, and a `stat` a beat later says "exists" for the
   *   successor's lock (measured, millions of times). Reading that as
   *   "stale" would move a live lock aside. So an unreadable path is
   *   probed: gone after probes → free; present → live. Either way the
   *   caller only ever *creates or retries* — it never moves a lock it has
   *   not positively read as stale.
   */
  async #judgeLock(
    path: string,
    now: number,
  ): Promise<
    { judgment: "held" | "free" } | { judgment: "stale"; held: LockFile }
  > {
    const held = await this.#readJson<LockFile>(path);
    if (held !== undefined) {
      return held.expiresAt > now
        ? { judgment: "held" }
        : { judgment: "stale", held };
    }
    for (let probe = 0; probe < 3; probe++) {
      const exists = await stat(path)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        return { judgment: "free" };
      }
      await Bun.sleep(2 + Math.random() * 5);
    }
    return { judgment: "held" };
  }

  async acquireLock(
    ns: string,
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    const path = this.#lockPath(ns, key);
    const now = this.#now();
    const lock: LockFile = { owner, expiresAt: now + ttlMs };
    if (await this.#createExclusive(path, JSON.stringify(lock))) {
      return true;
    }
    const judgment = await this.#judgeLock(path, now);
    if (judgment.judgment === "held") {
      return false;
    }
    if (judgment.judgment === "stale") {
      if ((await this.#stealStale(path, judgment.held)) !== "free") {
        return false;
      }
    }
    return await this.#createExclusive(path, JSON.stringify(lock));
  }

  /**
   * Breaks a lock believed stale by renaming it aside, and answers whether
   * the path is `"free"` to create on.
   *
   * The TOCTOU the dance exists for: between the caller's read of `judged`
   * and the rename, the old holder can release and a *fresh, live* lock can
   * be linked at the path — the rename then moves that live lock aside. So
   * the aside's content is compared with what was judged (every lock file's
   * content is unique):
   *
   * - **Same content (or both missing):** the file we judged. Drop it and
   *   the path is free.
   * - **Different content:** a live lock we did not judge was moved. Put it
   *   back — with `link`, never `rename`, because rename *replaces* and
   *   would overwrite a lock another contender linked meanwhile (the
   *   measured herd bug: a fresh lock restored over a second linker's, and
   *   the orphaned release failing on owner mismatch stalled the herd for
   *   the whole TTL). If the path is taken, the taken lock is short-lived:
   *   retry until it frees, or until the moved lock expires — then it is
   *   debris like any stale lock.
   *
   * `"held"` answers on a restore: the caller treats it as any failed
   * acquire (it retries, per its own policy).
   */
  async #stealStale(
    path: string,
    judged: LockFile | undefined,
  ): Promise<"free" | "held"> {
    const aside = `${path}.${process.pid}.${crypto.randomUUID()}.stale`;
    try {
      await rename(path, aside);
    } catch {
      // Gone already (released or broken by another contender), or raced.
      return "free";
    }
    const moved = await this.#readJson<LockFile>(aside);
    const sameFile =
      (moved === undefined && judged === undefined) ||
      (moved !== undefined &&
        judged !== undefined &&
        moved.owner === judged.owner &&
        moved.expiresAt === judged.expiresAt);
    if (!sameFile && moved !== undefined) {
      // A live lock we did not judge was moved aside: restore it.
      for (;;) {
        try {
          await link(aside, path);
          await rm(aside, { force: true }).catch(() => undefined);
          return "held";
        } catch {
          if (this.#now() >= moved.expiresAt) {
            // It expired while we waited: it is debris now.
            await rm(aside, { force: true }).catch(() => undefined);
            return "free";
          }
          await Bun.sleep(2);
        }
      }
    }
    await rm(aside, { force: true }).catch(() => undefined);
    return "free";
  }

  /**
   * `acquireLock` over a path, with waiting: retries until the lock is taken,
   * breaking stale holders aside. Used where losing is not an option (the bus
   * append). The lock file holds the owner's expiry, so a dead holder lapses.
   */
  async #takeFileLock(
    path: string,
    owner: string,
    ttlMs: number,
  ): Promise<() => Promise<void>> {
    for (;;) {
      const now = this.#now();
      const lock: LockFile = { owner, expiresAt: now + ttlMs };
      if (await this.#createExclusive(path, JSON.stringify(lock))) {
        return async () => {
          const held = await this.#readJson<LockFile>(path);
          if (held !== undefined && held.owner === owner) {
            await unlink(path).catch(() => undefined);
          }
        };
      }
      const judgment = await this.#judgeLock(path, now);
      if (judgment.judgment === "stale") {
        await this.#stealStale(path, judgment.held);
      }
      await Bun.sleep(5 + Math.random() * 20);
    }
  }

  async releaseLock(ns: string, key: string, owner: string): Promise<boolean> {
    const path = this.#lockPath(ns, key);
    // A transient read failure must not orphan the lock for its whole TTL:
    // probe like `#judgeLock` does before concluding anything.
    for (let probe = 0; probe < 3; probe++) {
      const held = await this.#readJson<LockFile>(path);
      if (held !== undefined) {
        if (held.owner !== owner) {
          return false;
        }
        await unlink(path).catch(() => undefined);
        return true;
      }
      const exists = await stat(path)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        return false;
      }
      await Bun.sleep(2 + Math.random() * 5);
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* the sweeper                                                       */
  /* ---------------------------------------------------------------- */

  /** Every file under `dir`, recursively, with its mtime. Missing directories answer empty. */
  async #walk(
    dir: string,
  ): Promise<{ path: string; mtimeMs: number; size: number }[]> {
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: { path: string; mtimeMs: number; size: number }[] = [];
    for (const name of names) {
      const path = join(dir, name.name);
      if (name.isDirectory()) {
        out.push(...(await this.#walk(path)));
      } else if (name.isFile()) {
        const info = await stat(path).catch(() => undefined);
        if (info !== undefined) {
          out.push({ path, mtimeMs: info.mtimeMs, size: info.size });
        }
      }
    }
    return out;
  }

  async sweep(now: number, limit: number): Promise<number> {
    let removed = 0;
    let namespaces: string[] = [];
    try {
      namespaces = (await readdir(this.#options.root)).filter(
        (name) => name !== "bus.log" && name !== "bus.lock",
      );
    } catch {
      return 0;
    }
    const entriesByAge: { path: string; mtimeMs: number; size: number }[] = [];
    let totalBytes = 0;
    let totalEntries = 0;
    for (const namespace of namespaces) {
      if (removed >= limit) {
        break;
      }
      const nsDir = join(this.#options.root, namespace);
      // Expired entries, from the 14-byte header only (§7.2).
      const entryFiles = await this.#walk(join(nsDir, "e"));
      for (const file of entryFiles) {
        if (file.path.endsWith(".tmp")) {
          // A writer died between the write and the rename: debris.
          if (now - file.mtimeMs > 3_600_000) {
            await unlink(file.path).catch(() => undefined);
          }
          continue;
        }
        const expiresAt = await readExpiry(file.path);
        if (expiresAt === undefined) {
          continue;
        }
        if (expiresAt !== null && expiresAt <= now) {
          if (removed < limit) {
            await unlink(file.path).catch(() => undefined);
            removed++;
          }
        } else {
          entriesByAge.push(file);
          totalBytes += file.size;
          totalEntries++;
        }
      }
      // Expired stamps, locks and counters.
      for (const sub of ["s", "l"] as const) {
        for (const file of await this.#walk(join(nsDir, sub))) {
          const record = await this.#readJson<{
            until?: number;
            expiresAt?: number;
          }>(file.path);
          const expiresAt = record?.until ?? record?.expiresAt;
          if (expiresAt !== undefined && expiresAt <= now) {
            await unlink(file.path).catch(() => undefined);
          }
        }
      }
      for (const file of await this.#walk(join(nsDir, "n"))) {
        const counter = await this.#readJson<CounterFile>(file.path);
        if (
          counter !== undefined &&
          counter.expiresAt !== null &&
          counter.expiresAt <= now
        ) {
          await unlink(file.path).catch(() => undefined);
        }
      }
    }
    // The caps, oldest by mtime first: age order, not LRU (§3.9).
    const { maxEntries, maxBytes } = this.#options;
    if (maxEntries !== undefined || maxBytes !== undefined) {
      entriesByAge.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const victim of entriesByAge) {
        const over =
          (maxEntries !== undefined && totalEntries > maxEntries) ||
          (maxBytes !== undefined && totalBytes > maxBytes);
        if (!over) {
          break;
        }
        await unlink(victim.path).catch(() => undefined);
        totalEntries--;
        totalBytes -= victim.size;
      }
    }
    return removed;
  }

  /* ---------------------------------------------------------------- */
  /* the bus (a polled append-only log, §4.2)                          */
  /* ---------------------------------------------------------------- */

  async publish(message: BusMessage): Promise<void> {
    // One writer at a time across processes: the append and the compaction
    // check are one critical section under the bus lock.
    const release = await this.#takeFileLock(
      this.#busLockPath(),
      `bus:${process.pid}:${crypto.randomUUID()}`,
      5_000,
    );
    try {
      const path = this.#busPath();
      await this.#ensureDir(this.#options.root);
      const line = `${JSON.stringify(message)}\n`;
      const handle = await open(path, "a");
      try {
        await handle.appendFile(line);
      } finally {
        await handle.close();
      }
      const size = (await stat(path)).size;
      if (size > this.#options.maxBusLogBytes) {
        // Compact: keep the newest half. Subscribers whose offset is now past
        // the end see a gap and flush — the bus's documented answer to a gap
        // (§4.2).
        const bytes = await readFile(path);
        const keep = bytes.slice(size - Math.floor(size / 2));
        const firstNewline = keep.indexOf(0x0a);
        await this.#writeAtomic(
          path,
          firstNewline === -1 ? keep : keep.subarray(firstNewline + 1),
        );
      }
    } finally {
      await release();
    }
  }

  async subscribe(
    onMessage: (message: BusMessage) => void,
    onGap: () => void,
  ): Promise<() => Promise<void>> {
    const path = this.#busPath();
    let offset = 0;
    try {
      offset = (await stat(path)).size;
    } catch {
      // No log yet: everything published from now on is new.
    }
    let pending = "";
    const poller = setInterval(() => {
      void (async () => {
        const size = await stat(path)
          .then((info) => info.size)
          .catch(() => 0);
        if (size < offset) {
          // The log was compacted: everything between is lost. That is a gap
          // (§4.2): flush, then resume from the new end.
          offset = size;
          pending = "";
          onGap();
          return;
        }
        if (size === offset) {
          return;
        }
        const handle = await open(path, "r");
        let chunk: Buffer;
        try {
          const result = await handle.read(
            Buffer.alloc(size - offset),
            0,
            size - offset,
            offset,
          );
          chunk = result.buffer.subarray(0, result.bytesRead);
        } finally {
          await handle.close();
        }
        offset = size;
        pending += chunk.toString("utf8");
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line !== "") {
            try {
              onMessage(JSON.parse(line) as BusMessage);
            } catch {
              // A torn line (a writer died mid-append): skip it.
            }
          }
          newline = pending.indexOf("\n");
        }
      })().catch(() => undefined);
    }, this.#options.busPollInterval);
    poller.unref?.();
    this.#pollers.add(poller);
    return async () => {
      clearInterval(poller);
      this.#pollers.delete(poller);
    };
  }

  /** The schema is new; there is nothing to sync (§7.4). */
  syncSchema(_options?: SchemaSyncOptions): Promise<SchemaChange[]> {
    return Promise.resolve([]);
  }
}

/** A file driver (§7.2): one directory, one file per entry. See {@link FileDriverOptions}. */
export function fileDriver(options: FileDriverOptions): CacheDriver {
  return new FileDriver(options);
}
