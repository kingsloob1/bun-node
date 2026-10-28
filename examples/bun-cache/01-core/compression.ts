/**
 * Compression — what an entry costs in the store, and how to change it: the
 * four built-in algorithms (zstd, gzip, Brotli, raw DEFLATE), `level`, user
 * compressors (sync and async, `previous`), `compress: false` per call, and
 * the decompression cap. Memory driver, no server.
 *
 * ```bash
 * bun 01-core/compression.ts
 * ```
 *
 * - The proof is the driver's own bytes: this file reads the stored entry
 *   back with `driver.get` and looks at its header (`"BC"`, then the format
 *   byte, the codec byte, the flags byte; format 2 adds a compressor-id byte).
 *   Nothing else is read from the header.
 * - The default is zstd above 16 KiB, only when that makes the entry smaller.
 *   Format 1 (none, zstd, gzip) is what the package always wrote; `br`,
 *   `deflate` and user compressors write format 2.
 * - The sizes printed are for this file's made-up value; the checks assert
 *   "smaller than the value", never a ratio.
 */
import {
  brotliCompress,
  brotliCompressSync,
  brotliDecompress,
  constants as zlibConstants,
  gzipSync,
  gunzipSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import type { ZstdOptions } from "node:zlib";
import type {
  CacheCompressor,
  CacheDriver,
  CompressOptions,
} from "@kingsleyweb/bun-cache";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("bun-cache compression: built-ins, levels, user compressors, the cap");

/** The namespace every cache here uses, so they can share one driver. */
const NS = "example";

/** What a stored entry's header says. */
interface Stored {
  /** The entry's whole size, header included. */
  size: number;
  /** The format byte: 1 (none, zstd, gzip) or 2 (a compressor-id byte). */
  format: number;
  /** The compressor id: 0 none, 1 zstd, 2 gzip, 3 br, 4 deflate, 128–255 a user compressor. */
  compressor: number;
}

/** Reads `key` from the driver, bypassing the cache, and parses what this file needs of its header. */
async function stored(driver: CacheDriver, key: string): Promise<Stored> {
  const entry = await driver.get(NS, key);
  if (entry === undefined) {
    throw new Error(`nothing stored under ${key}`);
  }
  const bytes = entry.value;
  const format = bytes[2];
  // Format 1 keeps the compressor in the flags byte's low two bits (1 zstd,
  // 2 gzip); format 2 has a byte of its own after the flags.
  const compressor = format === 1 ? bytes[4] & 3 : bytes[5];
  return { size: bytes.byteLength, format, compressor };
}

/** The same value's JSON size, which the stored size is compared with. */
function jsonSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** A deterministic JSON-ish value of about `rows` * 50 bytes: repetitive enough to compress, varied enough to be real. */
function makeReport(rows: number): { id: string; rows: object[] } {
  return {
    id: "report",
    rows: Array.from({ length: rows }, (_, index) => ({
      id: index,
      name: `customer-${index % 40}`,
      status: index % 3 === 0 ? "active" : "idle",
      total: (index * 37) % 1000,
    })),
  };
}

/** About 20 KB as JSON: above the 16 KiB default threshold. */
const report = makeReport(380);
/** About 1 KB as JSON: under it. */
const small = makeReport(15);
/** About 70 KB as JSON, for the level timings. */
const large = makeReport(1300);

/** Makes a cache over `driver` with `compress`, sharing the example's namespace. */
function cacheOf(driver: CacheDriver, compress?: CompressOptions | false) {
  return createCache({ driver, namespace: NS, ttl: null, compress });
}

/* ------------------------------------------------------------------ */
step("the default: zstd above 16 KiB, nothing below");

const driver = memoryDriver();
const cache = cacheOf(driver);
show("value sizes (JSON)", {
  report: jsonSize(report),
  small: jsonSize(small),
});
check("the report is over the 16 KiB threshold", jsonSize(report) > 16 * 1024);
check("the small value is under it", jsonSize(small) < 16 * 1024);

await cache.set("report", report);
await cache.set("small", small);
const big = await stored(driver, "report");
const little = await stored(driver, "small");
show("stored report", big);
show("stored small", little);
checkEqual(
  "the report is zstd, format 1",
  [big.format, big.compressor],
  [1, 1],
);
check("…and smaller than the value", big.size < jsonSize(report) / 2, big);
checkEqual(
  "the small one is uncompressed",
  [little.format, little.compressor],
  [1, 0],
);
checkEqual("the report reads back", await cache.get("report"), report);
checkEqual("the small value reads back", await cache.get("small"), small);

/* ------------------------------------------------------------------ */
step("gzip, br and deflate");

// `br` and `deflate` write format 2, whose extra byte names the compressor
// (3, 4); gzip stays in format 1, flagged in the flags byte.
const expected = {
  gzip: { format: 1, compressor: 2 },
  br: { format: 2, compressor: 3 },
  deflate: { format: 2, compressor: 4 },
} as const;
for (const algorithm of ["gzip", "br", "deflate"] as const) {
  const algorithmDriver = memoryDriver();
  const algorithmCache = cacheOf(algorithmDriver, { algorithm });
  await algorithmCache.set("report", report);
  const entry = await stored(algorithmDriver, "report");
  show(`${algorithm} stored`, entry);
  checkEqual(
    `${algorithm}: format and compressor id`,
    { format: entry.format, compressor: entry.compressor },
    expected[algorithm],
  );
  check(
    `${algorithm}: stored smaller than the value`,
    entry.size < jsonSize(report) / 2,
    entry,
  );
  checkEqual(
    `${algorithm}: round-trips`,
    await algorithmCache.get("report"),
    report,
  );
  await algorithmCache.close();
}

/* ------------------------------------------------------------------ */
step("level");

// Brotli's default quality is 4; 11 is smaller and much slower.
const timings: Record<string, { bytes: number; ms: number }> = {};
for (const level of [4, 11]) {
  const levelDriver = memoryDriver();
  const levelCache = cacheOf(levelDriver, { algorithm: "br", level });
  const startedAt = performance.now();
  await levelCache.set("large", large);
  const ms = performance.now() - startedAt;
  const entry = await stored(levelDriver, "large");
  timings[`br ${level}`] = {
    bytes: entry.size,
    ms: Math.round(ms * 100) / 100,
  };
  checkEqual(
    `br level ${level} round-trips`,
    await levelCache.get("large"),
    large,
  );
  await levelCache.close();
}
show("br 70 KB: stored bytes and set time (ms)", timings);
check(
  "quality 11 stored no more than quality 4",
  timings["br 11"].bytes <= timings["br 4"].bytes,
  timings,
);

// A bad option is a TypeError at createCache, naming the option.
const badOptions: [string, CompressOptions][] = [
  ["zstd level 0 (range 1–22)", { algorithm: "zstd", level: 0 }],
  ["br level 12 (range 0–11)", { algorithm: "br", level: 12 }],
  ["gzip level 1.5 (not an integer)", { algorithm: "gzip", level: 1.5 }],
  ["an unknown algorithm", { algorithm: "brotli" as "br" }],
  [
    "a user compressor with an id under 128",
    { algorithm: { id: 5, compress: (b) => b, decompress: (b) => b } },
  ],
  [
    "a user compressor beside a level",
    {
      algorithm: { id: 130, compress: (b) => b, decompress: (b) => b },
      level: 3,
    },
  ],
  [
    "two compressors with one id",
    {
      algorithm: { id: 130, compress: (b) => b, decompress: (b) => b },
      previous: [{ id: 130, compress: (b) => b, decompress: (b) => b }],
    },
  ],
];
for (const [label, compress] of badOptions) {
  let thrown: unknown;
  try {
    createCache({ driver: memoryDriver(), compress });
  } catch (error) {
    thrown = error;
  }
  check(`${label} is a TypeError`, thrown instanceof TypeError, thrown);
}

/* ------------------------------------------------------------------ */
step("changing the algorithm needs no flush");

// One driver, four caches with four algorithms, one namespace (none is
// closed before the reads: closing a cache closes its driver): each entry's
// header names its compressor, and every built-in always decompresses.
const mixed = memoryDriver();
const writers: [string, CompressOptions][] = [
  ["a", { algorithm: "zstd" }],
  ["b", { algorithm: "br" }],
  ["c", { algorithm: "deflate" }],
  ["d", { algorithm: "gzip" }],
];
for (const [key, compress] of writers) {
  const writer = cacheOf(mixed, compress);
  await writer.set(key, report);
}
const ids: number[] = [];
for (const [key] of writers) {
  ids.push((await stored(mixed, key)).compressor);
}
checkEqual("four entries, four compressors in one store", ids, [1, 3, 4, 2]);
// A cache configured for gzip, and another with compression off, read all four.
const gzipReader = cacheOf(mixed, { algorithm: "gzip" });
const plainReader = cacheOf(mixed, false);
for (const [key] of writers) {
  checkEqual(`gzip cache reads ${key}`, await gzipReader.get(key), report);
  checkEqual(
    `compress:false cache reads ${key}`,
    await plainReader.get(key),
    report,
  );
}
await gzipReader.close();
await plainReader.close();

/* ------------------------------------------------------------------ */
step("compress: false, per call");

// Besides bytes that are already compressed (which the "only if smaller" rule
// would store as they are anyway, after spending the time), this is the
// answer to a compression oracle: a value mixing a secret with text an
// attacker chooses leaks the secret through its compressed size, so such a
// value is stored uncompressed.
const perCall = memoryDriver();
const perCallCache = cacheOf(perCall);
await perCallCache.set("compressed", report);
await perCallCache.set("kept", report, { compress: false });
await perCallCache.getOrSet("loaded", () => report, { compress: false });
const compressedEntry = await stored(perCall, "compressed");
const keptEntry = await stored(perCall, "kept");
const loadedEntry = await stored(perCall, "loaded");
show("sizes: compressed / kept / loaded", [
  compressedEntry.size,
  keptEntry.size,
  loadedEntry.size,
]);
checkEqual("the default call compressed (zstd)", compressedEntry.compressor, 1);
checkEqual(
  "set(compress: false) stored it uncompressed",
  keptEntry.compressor,
  0,
);
checkEqual("getOrSet(compress: false) likewise", loadedEntry.compressor, 0);
check(
  "uncompressed is over half the JSON; compressed is under half of that",
  keptEntry.size > jsonSize(report) / 2 &&
    compressedEntry.size < keptEntry.size / 2,
  { compressedEntry, keptEntry },
);
checkEqual("it reads back", await perCallCache.get("kept"), report);
// touch keeps an uncompressed entry uncompressed (it would otherwise
// recompress what the caller kept out of compression).
await perCallCache.touch("kept", 60_000);
checkEqual(
  "…and touch leaves it uncompressed",
  (await stored(perCall, "kept")).compressor,
  0,
);
await perCallCache.close();

/* ------------------------------------------------------------------ */
step("user compressors: sync, async, previous");

// A dictionary-trained zstd (Bun's native zstd takes no dictionary). Here the
// dictionary is raw content: the report's own opening rows, which zstd
// accepts as a dictionary of "likely content".
const dictionary = new TextEncoder().encode(JSON.stringify(makeReport(60)));
// Bun's node:zlib honours `dictionary`; @types/node does not declare it yet.
const withDictionary = (options: ZstdOptions = {}) =>
  ({ ...options, dictionary }) as ZstdOptions;
const zstdDict: CacheCompressor = {
  id: 128,
  compress: (bytes) => zstdCompressSync(bytes, withDictionary()),
  decompress: (bytes, maxOutputLength) =>
    zstdDecompressSync(bytes, withDictionary({ maxOutputLength })),
};

/** How many times the async compressor ran each way. */
const asyncCalls = { compress: 0, decompress: 0 };
// An async one: node:zlib's callback API wrapped in promises, Brotli at
// quality 9. The cache awaits a compressor only when it answers a promise.
const brAsync: CacheCompressor = {
  id: 129,
  compress: (bytes) =>
    new Promise<Uint8Array>((resolve, reject) => {
      asyncCalls.compress++;
      brotliCompress(
        bytes,
        { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } },
        (error, result) => (error ? reject(error) : resolve(result)),
      );
    }),
  decompress: (bytes, maxOutputLength) =>
    new Promise<Uint8Array>((resolve, reject) => {
      asyncCalls.decompress++;
      brotliDecompress(bytes, { maxOutputLength }, (error, result) =>
        error ? reject(error) : resolve(result),
      );
    }),
};

const userDriver = memoryDriver();
const dictCache = cacheOf(userDriver, { algorithm: zstdDict });
await dictCache.set("sync", report);
const syncEntry = await stored(userDriver, "sync");
show("id-128 (dictionary zstd) stored", syncEntry);
checkEqual(
  "a user compressor writes format 2 with its own id",
  [syncEntry.format, syncEntry.compressor],
  [2, 128],
);
check(
  "…smaller than the value",
  syncEntry.size < jsonSize(report) / 2,
  syncEntry,
);
checkEqual(
  "the sync compressor round-trips",
  await dictCache.get("sync"),
  report,
);

const asyncCache = cacheOf(userDriver, { algorithm: brAsync });
await asyncCache.set("async", report);
const asyncEntry = await stored(userDriver, "async");
show("id-129 (async Brotli) stored", asyncEntry);
checkEqual("the async compressor's id is stored", asyncEntry.compressor, 129);
checkEqual(
  "the async compressor round-trips",
  await asyncCache.get("async"),
  report,
);
checkEqual("it ran once each way", asyncCalls, { compress: 1, decompress: 1 });

// A compressor that does not shrink the payload is not used: the same
// "only if smaller" rule as the built-ins.
const identity: CacheCompressor = {
  id: 131,
  compress: (bytes) => bytes,
  decompress: (bytes) => bytes,
};
const identityCache = cacheOf(userDriver, { algorithm: identity });
await identityCache.set("same", report);
checkEqual(
  "a compressor that does not shrink the payload leaves it uncompressed",
  (await stored(userDriver, "same")).compressor,
  0,
);

// Changing compressor: the new one takes a new id, the old goes in `previous`
// while its entries live. Without it, those entries are a miss — and are
// deleted, with an `error` event of phase "decode".
const gzipUser: CacheCompressor = {
  id: 130,
  compress: (bytes) => gzipSync(bytes),
  decompress: (bytes, maxOutputLength) =>
    gunzipSync(bytes, { maxOutputLength }),
};
await dictCache.set("old-a", report);
await dictCache.set("old-b", report);

const withPrevious = cacheOf(userDriver, {
  algorithm: gzipUser,
  previous: [zstdDict],
});
checkEqual(
  "with previous, the old id-128 entry reads",
  await withPrevious.get("old-a"),
  report,
);
await withPrevious.set("new", report);
checkEqual(
  "…and new writes use id 130",
  (await stored(userDriver, "new")).compressor,
  130,
);

const withoutPrevious = cacheOf(userDriver, { algorithm: gzipUser });
const unknownErrors: { phase: string; key?: string }[] = [];
withoutPrevious.on("error", ({ phase, key }) =>
  unknownErrors.push({ phase, key }),
);
checkEqual(
  "without previous, the id-128 entry is a miss",
  await withoutPrevious.get("old-b"),
  undefined,
);
checkEqual("…with a decode error event", unknownErrors, [
  { phase: "decode", key: "old-b" },
]);
check(
  "…and the entry was deleted",
  (await userDriver.get(NS, "old-b")) === undefined,
);

// Rolling deploy: br, deflate and user compressors write format 2. A process
// on a version from before format 2 reads such an entry as a miss, so while a
// deploy turns one of them on, old and new processes miss each other's
// entries; once every process is upgraded, nothing more changes.
check(
  "format-2 entries are the ones an older version would miss",
  (await stored(userDriver, "new")).format === 2 &&
    (await stored(userDriver, "sync")).format === 2,
);
for (const closing of [dictCache, asyncCache, withPrevious, withoutPrevious]) {
  await closing.close();
}

/* ------------------------------------------------------------------ */
step("the cap: a planted decompression bomb is a miss");

// A store writer could otherwise plant one small entry that expands to
// gigabytes when read. Every compressor — zstd and gzip included — is held to
// the entry limit: a read never decompresses past it. Here the limit is
// 64 KiB and each planted entry expands to 4 MiB.
const bombDriver = memoryDriver();
const bombCache = createCache({
  driver: bombDriver,
  namespace: NS,
  ttl: null,
  maxEntryBytes: 64 * 1024,
});
const bombErrors: { key?: string; phase: string }[] = [];
bombCache.on("error", ({ key, phase }) => bombErrors.push({ key, phase }));

/**
 * Plants an entry built by hand, as a store writer could: the raw codec (id
 * 3, so a successful decode would answer the expanded bytes), no flags, and
 * `payload` compressed with the compressor `id`. Format 1 for zstd and gzip
 * (the compressor in the flags byte), format 2 for br and deflate.
 */
async function plant(
  key: string,
  id: number,
  payload: Uint8Array,
): Promise<void> {
  const format = id <= 2 ? 1 : 2;
  const keyBytes = new TextEncoder().encode(key);
  const fixed = 33 + (format - 1);
  const out = new Uint8Array(fixed + keyBytes.length + payload.length);
  const view = new DataView(out.buffer);
  out.set([0x42, 0x43, format, 3]);
  const shift = format - 1;
  if (format === 1) {
    out[4] = id; // flag bit 0 zstd, bit 1 gzip: the ids 1 and 2
  } else {
    out[5] = id;
  }
  view.setFloat64(5 + shift, Date.now(), true); // createdAt
  view.setFloat64(13 + shift, -1, true); // freshUntil: never stale
  view.setFloat64(21 + shift, 0, true); // loadMs
  view.setUint32(29 + shift, keyBytes.length, true);
  out.set(keyBytes, fixed);
  out.set(payload, fixed + keyBytes.length);
  await bombDriver.set(NS, { key, value: out, expiresAt: null, tags: [] });
}

const zeros = new Uint8Array(4 * 1024 * 1024);
const bombs: [string, number, Uint8Array][] = [
  ["zstd", 1, Bun.zstdCompressSync(zeros)],
  ["gzip", 2, Bun.gzipSync(zeros)],
  ["br", 3, brotliCompressSync(zeros)],
  ["deflate", 4, Bun.deflateSync(zeros)],
];
for (const [name, id, payload] of bombs) {
  await plant(`bomb:${name}`, id, payload);
  const entry = await bombDriver.get(NS, `bomb:${name}`);
  show(`${name} bomb`, {
    storedBytes: entry?.value.byteLength,
    expandsTo: zeros.byteLength,
  });
  checkEqual(
    `${name} bomb reads as a miss`,
    await bombCache.get(`bomb:${name}`),
    undefined,
  );
  check(
    `${name} bomb was deleted`,
    (await bombDriver.get(NS, `bomb:${name}`)) === undefined,
  );
}
checkEqual(
  "each produced one error event of phase decode",
  bombErrors,
  bombs.map(([name]) => ({ key: `bomb:${name}`, phase: "decode" })),
);
await bombCache.close();

summary();
