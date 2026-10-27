/**
 * `fromSimpleDriver` (plan §6.1, §7.9): wraps a minimal `{ get, set, delete }`
 * store into a full {@link CacheDriver}. The wrapper adds the batch loops,
 * and stores tag stamps as ordinary entries under a reserved namespace, so a
 * three-method driver still gets correct lazy tags (`tags: "stamps"`, §3.6).
 */
import type {
  CacheDriver,
  CacheDriverCapabilities,
  SimpleCacheDriver,
  StoredEntry,
} from "./types";

/** The namespace the wrapper's tag stamps live under. */
const STAMPS_NS = "__bun_cache_stamps__";

/** Encodes a stamp's `at` (epoch ms) as its entry bytes. */
function encodeStamp(at: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, at, true);
  return bytes;
}

/** Decodes a stamp entry's bytes back to its `at`; `undefined` when it is not one. */
function decodeStamp(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength !== 8) {
    return undefined;
  }
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getFloat64(0, true);
}

/** See the module header. */
export function fromSimpleDriver(simple: SimpleCacheDriver): CacheDriver {
  const capabilities: CacheDriverCapabilities = {
    multiProcess: false,
    ttl: "sweep",
    atomicIncrement: false,
    lock: false,
    tags: "stamps",
    fence: "atomic",
    bus: "none",
    ...simple.capabilities,
  };
  const name = simple.name ?? "simple";
  return {
    name,
    capabilities,
    async close(): Promise<void> {
      await simple.close?.();
    },
    get(ns, key) {
      return simple.get(ns, key);
    },
    async getMany(ns, keys) {
      const out: (StoredEntry | undefined)[] = [];
      for (const key of keys) {
        out.push(await simple.get(ns, key));
      }
      return out;
    },
    async set(ns, entry) {
      await simple.set(ns, entry);
      return "stored" as const;
    },
    async setMany(ns, entries) {
      for (const entry of entries) {
        await simple.set(ns, entry);
      }
    },
    async delete(ns, keys) {
      let count = 0;
      for (const key of keys) {
        if (await simple.delete(ns, key)) {
          count++;
        }
      }
      return count;
    },
    async clear(ns) {
      if (simple.clear === undefined) {
        throw new Error(
          `the "${name}" simple driver has no clear(); give it one, or delete keys individually`,
        );
      }
      await simple.clear(ns);
      await simple.clear(`${STAMPS_NS}/${ns}`);
    },
    async getStamps(ns, tags) {
      const out = new Map<string, number>();
      const now = Date.now();
      for (const tag of tags) {
        const entry = await simple.get(`${STAMPS_NS}/${ns}`, tag);
        if (entry === undefined) {
          continue;
        }
        if (entry.expiresAt !== null && entry.expiresAt <= now) {
          await simple.delete(`${STAMPS_NS}/${ns}`, tag);
          continue;
        }
        const at = decodeStamp(entry.value);
        if (at !== undefined) {
          out.set(tag, at);
        }
      }
      return out;
    },
    async setStamps(ns, tags, at, until) {
      for (const tag of tags) {
        await simple.set(`${STAMPS_NS}/${ns}`, {
          key: tag,
          value: encodeStamp(at),
          expiresAt: until,
          tags: [],
        });
      }
    },
  };
}
