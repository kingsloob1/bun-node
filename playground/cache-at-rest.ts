/**
 * The cache lab's at-rest item (`/playground/cache/at-rest`, the encryption
 * plan's PR-E3): one value written through an encrypted cache with
 * `hashNames` on, shown as the store holds it beside what the cache answers,
 * with a plain cache's copy of the same value for contrast.
 *
 * - **The store** is one in-memory `bun:sqlite` database, which the
 *   playground opens itself and hands to two `sqliteDriver`s (prefixes
 *   `at_rest_sealed_` and `at_rest_plain_`), so the rows can be read back
 *   with plain SQL, around the drivers: every row of the entries and tag
 *   index tables, the sealed bytes in hex and base64, and a counter's row.
 * - **The sealed entry is opened by hand**, from the README's "The format"
 *   and "Hiding names" alone (HKDF-SHA-256, HMAC-SHA-256, AES-256-GCM from
 *   `node:crypto`; none of bun-cache's code): the envelope's fields, the
 *   sealed body, the entry header and its value, and each stored name
 *   recomputed from the names key. A mismatch is reported, so this checks
 *   the README's format against the code every time it runs.
 * - **Through the cache**: `get`, `getEntry`, the `hit` event's `keyId`, and
 *   `describeKey`, whose answer is checked against the row the store holds.
 *
 * The ring key and the names key are 32 random bytes drawn at startup
 * (`crypto.getRandomValues`), never written anywhere and never answered; a
 * restart draws new ones. `GET /playground/cache/at-rest` shows the last
 * write (one is made at startup); `POST /playground/cache/at-rest?note=&key=`
 * writes a new value through both caches and shows it.
 */
import type { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { Cache } from "@kingsleyweb/bun-cache";
import { deserialize } from "bun:jsc";
import { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import { createDecipheriv, createHmac, hkdfSync } from "node:crypto";
import { createCache, sqliteDriver } from "@kingsleyweb/bun-cache";

/** The namespace both caches write under: one name, two stores, so the rows compare directly. */
const NAMESPACE = "playground-at-rest";

/** The tags the demo's value carries. */
const TAGS = ["users", "org:7"] as const;

/** The key written when the request names none: an email, the kind of key that is itself a secret. */
const DEFAULT_KEY = "user:ada@example.com";

/** The note written when the request names none. */
const DEFAULT_NOTE = "a value the store should never show";

/** The id of the ring's one key. Not secret: it is written into every envelope. */
const KEY_ID = "playground-1";

/** `encrypt.aad`: bound into every entry, so a cache with another `aad` cannot open it. */
const AAD = "playground";

/** The longest key or note the routes accept. */
const MAX_INPUT = 200;

/** The table prefixes of the two drivers (one database). */
const PREFIX = { sealed: "at_rest_sealed_", plain: "at_rest_plain_" } as const;

/** The value the demo writes. */
interface DemoValue {
  /** An email: a plaintext needle in the store. */
  email: string;
  /** A plan name. */
  plan: string;
  /** The request's note. */
  note: string;
}

/** One row of a driver's entries table, as SQL answers it. */
interface EntryRow {
  /** The stored namespace. */
  ns: string;
  /** The stored key. */
  k: string;
  /** The stored bytes: an envelope, or a plain entry. */
  v: Uint8Array | null;
  /** A counter's value, in clear; `null` for an entry. */
  n: number | null;
  /** The clear hard expiry, epoch ms. */
  exp: number | null;
  /** The stored tags, as JSON. */
  tg: string | null;
  /** When the row was written, epoch ms. */
  ca: number | null;
}

/** One row of a driver's tag index. */
interface TagRow {
  /** The stored namespace. */
  ns: string;
  /** The stored tag. */
  tag: string;
  /** The stored key it indexes. */
  k: string;
}

/** What the routes answer. */
export interface AtRestView {
  /** What was written, through both caches. */
  written: { key: string; tags: readonly string[]; value: DemoValue };
  /** The encrypted cache, with `hashNames` on. */
  sealed: Record<string, unknown>;
  /** A plain cache over the same database, for contrast. */
  plain: Record<string, unknown>;
}

/** What the lab owns, for its shutdown. */
export interface AtRestDemo {
  /** Closes both caches and the database. */
  stop: () => Promise<void>;
}

/** The text encoder every needle and AAD part goes through. */
const encoder = new TextEncoder();

/** A strict UTF-8 decoder. */
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Mounts `GET` and `POST` `${base}/at-rest` on the adapter, and writes the first value. */
export async function mountAtRestDemo(
  app: BunHttpAdapter,
  base: string,
): Promise<AtRestDemo> {
  // Random at every start: never a constant, never logged or answered.
  const ringKey = crypto.getRandomValues(new Uint8Array(32));
  const namesKey = crypto.getRandomValues(new Uint8Array(32));
  const database = new Database(":memory:");
  const sealed = createCache({
    driver: sqliteDriver({ database, prefix: PREFIX.sealed }),
    namespace: NAMESPACE,
    ttl: 300_000,
    sweepInterval: 0,
    encrypt: {
      keys: [{ id: KEY_ID, key: ringKey }],
      aad: AAD,
      hashNames: { key: namesKey },
    },
  });
  const plain = createCache({
    driver: sqliteDriver({ database, prefix: PREFIX.plain }),
    namespace: NAMESPACE,
    ttl: 300_000,
    sweepInterval: 0,
  });
  let last: { key: string; value: DemoValue } = {
    key: DEFAULT_KEY,
    value: demoValue(DEFAULT_NOTE),
  };

  /** Writes `value` under `key` through both caches, with a counter beside it. */
  const write = async (key: string, value: DemoValue): Promise<void> => {
    for (const cache of [sealed, plain]) {
      await cache.set(key, value, { tags: [...TAGS] });
      await cache.increment(`visits:${key}`, 1);
    }
    last = { key, value };
  };

  /** The page's view of the last write. */
  const view = async (): Promise<AtRestView> => {
    const { key, value } = last;
    const needles = [key, NAMESPACE, ...TAGS, value.email, value.note];
    const sealedRows = rows(database, PREFIX.sealed);
    const plainRows = rows(database, PREFIX.plain);
    const described = sealed.describeKey(key, [...TAGS]);
    const sealedEntry = sealedRows.entries.find(
      (row) => row.ns === described.namespace && row.k === described.key,
    );
    const plainEntry = plainRows.entries.find(
      (row) => row.ns === NAMESPACE && row.k === key,
    );
    return {
      written: { key, tags: TAGS, value },
      sealed: {
        options:
          "encrypt: { keys: [{ id: 'playground-1', key: <32 random bytes> }], aad: 'playground', hashNames: { key: <32 random bytes> } }",
        store: {
          entries: sealedRows.entries.map(showRow),
          tags: sealedRows.tags,
          plaintextFound: searchStore(sealedRows, needles),
        },
        envelope:
          sealedEntry?.v === undefined || sealedEntry.v === null
            ? { error: "no sealed row at describeKey's names" }
            : openByHand(sealedEntry.v, ringKey, key),
        namesByHand: namesByHand(namesKey, key, described),
        cache: await throughCache(sealed, key, described, sealedEntry),
      },
      plain: {
        options: "no encrypt",
        store: {
          entries: plainRows.entries.map(showRow),
          tags: plainRows.tags,
          plaintextFound: searchStore(plainRows, needles),
        },
        entry:
          plainEntry?.v === undefined || plainEntry.v === null
            ? { error: "no plain row" }
            : readEntry(plainEntry.v),
        cache: await throughCache(
          plain,
          key,
          plain.describeKey(key, [...TAGS]),
          plainEntry,
        ),
      },
    };
  };

  await write(last.key, last.value);

  app.get(`${base}/at-rest`, async (_req, res) => {
    res.json(await view());
  });

  app.post(`${base}/at-rest`, async (req, res) => {
    const query = req.query as Record<string, string | undefined>;
    const key = query.key ?? last.key;
    const note = query.note ?? DEFAULT_NOTE;
    for (const [name, text] of [
      ["key", key],
      ["note", note],
    ] as const) {
      if (
        text.length === 0 ||
        text.length > MAX_INPUT ||
        [...text].some((char) => char.charCodeAt(0) < 0x20)
      ) {
        res.status(400).json({
          error: `${name} must be 1–${MAX_INPUT} characters, with no control characters`,
        });
        return;
      }
    }
    // Only the last write's rows are shown: start each write from empty tables.
    await sealed.clear();
    await plain.clear();
    await write(key, demoValue(note));
    res.json(await view());
  });

  return {
    stop: async () => {
      await sealed.close();
      await plain.close();
      database.close();
    },
  };
}

/** The demo's value, around `note`. */
function demoValue(note: string): DemoValue {
  return { email: "ada@example.com", plan: "pro", note };
}

/** Every entry and tag-index row of the driver whose tables start with `prefix`. */
function rows(
  database: Database,
  prefix: string,
): { entries: EntryRow[]; tags: TagRow[] } {
  return {
    entries: database
      .query<EntryRow, []>(
        `SELECT ns, k, v, n, exp, tg, ca FROM ${prefix}entries ORDER BY n IS NOT NULL, k`,
      )
      .all(),
    tags: database
      .query<TagRow, []>(`SELECT ns, tag, k FROM ${prefix}tags ORDER BY tag`)
      .all(),
  };
}

/** A row for the page: its bytes in hex and base64. */
function showRow(row: EntryRow): Record<string, unknown> {
  return {
    ns: row.ns,
    k: row.k,
    tg: row.tg,
    exp: row.exp,
    ca: row.ca,
    ...(row.n === null ? {} : { n: row.n }),
    ...(row.v === null
      ? {}
      : {
          bytes: row.v.byteLength,
          hex: Buffer.from(row.v).toString("hex"),
          base64: Buffer.from(row.v).toString("base64"),
        }),
  };
}

/** For each needle, whether any row shows it, in UTF-8 or UTF-16LE (a raw dump's two spellings). */
function searchStore(
  store: { entries: EntryRow[]; tags: TagRow[] },
  needles: readonly string[],
): Record<string, boolean> {
  const haystack: Buffer[] = [];
  for (const row of store.entries) {
    haystack.push(Buffer.from(`${row.ns}\n${row.k}\n${row.tg ?? ""}`));
    if (row.v !== null) {
      haystack.push(Buffer.from(row.v));
    }
  }
  for (const row of store.tags) {
    haystack.push(Buffer.from(`${row.ns}\n${row.tag}\n${row.k}`));
  }
  const all = Buffer.concat(haystack);
  return Object.fromEntries(
    needles.map((needle) => [
      needle,
      all.includes(Buffer.from(needle, "utf8")) ||
        all.includes(Buffer.from(needle, "utf16le")),
    ]),
  );
}

/** Concatenates byte strings. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

/** A hex string, for the page. */
function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Opens a built-in envelope from the README's "The format" alone: the
 * prefix's fields, K and K_salt, the AAD, AES-256-GCM, then the sealed body
 * and the entry inside it. Answers each step's result, or where it failed.
 */
function openByHand(
  bytes: Uint8Array,
  ringKey: Uint8Array,
  key: string,
): Record<string, unknown> {
  const magic = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0);
  const idLength = bytes[4] ?? 0;
  const saltAt = 5 + idLength;
  const nonceAt = saltAt + 16;
  const bodyAt = nonceAt + 12;
  const tagAt = bytes.length - 16;
  const fields = {
    magic,
    version: bytes[2],
    cipherId: bytes[3],
    cipher: bytes[3] === 1 ? "aes-256-gcm" : "a user cipher",
    keyIdLength: idLength,
    keyId: decoder.decode(bytes.subarray(5, saltAt)),
    salt: hex(bytes.subarray(saltAt, nonceAt)),
    nonce: hex(bytes.subarray(nonceAt, bodyAt)),
    ciphertextBytes: tagAt - bodyAt,
    gcmTag: hex(bytes.subarray(tagAt)),
  };
  try {
    const k = new Uint8Array(
      hkdfSync(
        "sha256",
        ringKey,
        new Uint8Array(0),
        "bun-cache/enc/1/aes-256-gcm",
        32,
      ),
    );
    const kSalt = createHmac("sha256", k)
      .update("entry")
      .update(bytes.subarray(saltAt, nonceAt))
      .update(new Uint8Array([1]))
      .digest();
    const zero = new Uint8Array([0]);
    const aad = concat([
      encoder.encode("bun-cache/enc/1"),
      zero,
      encoder.encode(NAMESPACE),
      zero,
      encoder.encode(key),
      zero,
      encoder.encode(AAD),
      zero,
      bytes.subarray(0, bodyAt),
    ]);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      kSalt,
      bytes.subarray(nonceAt, bodyAt),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(tagAt));
    const body = concat([
      decipher.update(bytes.subarray(bodyAt, tagAt)),
      decipher.final(),
    ]);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const expiresAt = view.getFloat64(1, true);
    const count = view.getUint16(9, true);
    const tags: string[] = [];
    let at = 11;
    for (let index = 0; index < count; index++) {
      const length = view.getUint16(at, true);
      tags.push(decoder.decode(body.subarray(at + 2, at + 2 + length)));
      at += 2 + length;
    }
    const entry = body.subarray(at);
    const tagBytes = tags.reduce(
      (sum, tag) => sum + 2 + encoder.encode(tag).byteLength,
      0,
    );
    return {
      fields,
      opened: true,
      sealedBody: {
        version: body[0],
        expiresAt: expiresAt === -1 ? null : expiresAt,
        tags,
      },
      entry: readEntry(entry),
      sizes: {
        sealed: bytes.byteLength,
        plainEntry: entry.byteLength,
        overhead: bytes.byteLength - entry.byteLength,
        formula: `49 + ${idLength} (key id) + 11 + ${tagBytes} (tags) = ${49 + idLength + 11 + tagBytes}`,
      },
    };
  } catch (error) {
    return {
      fields,
      opened: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Reads a core entry from the README's format 1 or 2, and its value when it is uncompressed structured clone. */
function readEntry(bytes: Uint8Array): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = bytes[2];
  const at = format === 2 ? 6 : 5;
  const flags = bytes[4] ?? 0;
  const compressor =
    format === 2 ? bytes[5] : flags & 1 ? 1 : flags & 2 ? 2 : 0;
  const keyLength = view.getUint32(at + 24, true);
  const keyAt = at + 28;
  const payload = bytes.subarray(keyAt + keyLength);
  const freshUntil = view.getFloat64(at + 8, true);
  return {
    magic: String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0),
    format,
    codec: bytes[3] === 1 ? "structured" : bytes[3],
    flags,
    compressor,
    createdAt: view.getFloat64(at, true),
    freshUntil: freshUntil === -1 ? null : freshUntil,
    loadMs: view.getFloat64(at + 16, true),
    key: decoder.decode(bytes.subarray(keyAt, keyAt + keyLength)),
    payloadBytes: payload.byteLength,
    value:
      bytes[3] === 1 && compressor === 0
        ? (deserialize(payload) as unknown)
        : "(compressed or not structured clone: not decoded here)",
  };
}

/** One stored name recomputed from the README's "Hiding names" formula. */
function nameHash(
  namesKey: Uint8Array,
  label: "ns" | "key" | "tag",
  name?: string,
): string {
  const kNames = new Uint8Array(
    hkdfSync("sha256", namesKey, new Uint8Array(0), "bun-cache/names/1", 32),
  );
  const hmac = createHmac("sha256", kNames).update(`${label}\0${NAMESPACE}`);
  if (name !== undefined) {
    hmac.update(`\0${name}`);
  }
  return hmac.digest("hex").slice(0, 32);
}

/** The stored names recomputed by hand, against `describeKey`'s answer. */
function namesByHand(
  namesKey: Uint8Array,
  key: string,
  described: { namespace: string; key: string; tags: string[] },
): Record<string, unknown> {
  const namespace = nameHash(namesKey, "ns");
  const storedKey = nameHash(namesKey, "key", key);
  const tags = TAGS.map((tag) => nameHash(namesKey, "tag", tag));
  return {
    namespace,
    key: storedKey,
    tags,
    matchDescribeKey:
      namespace === described.namespace &&
      storedKey === described.key &&
      tags.every((tag, index) => tag === described.tags[index]),
  };
}

/** What `cache` answers for `key`, with `describeKey` checked against the row the store holds. */
async function throughCache(
  cache: Cache,
  key: string,
  described: { namespace: string; key: string; tags: string[] },
  row: EntryRow | undefined,
): Promise<Record<string, unknown>> {
  const hits: (string | undefined)[] = [];
  const off = cache.on("hit", (event) => {
    hits.push(event.keyId);
  });
  try {
    const value = await cache.get(key);
    const entry = await cache.getEntry(key);
    const storedTags =
      row?.tg === null || row?.tg === undefined
        ? []
        : (JSON.parse(row.tg) as string[]);
    return {
      describeKey: described,
      describeKeyMatchesStore:
        row !== undefined &&
        row.ns === described.namespace &&
        row.k === described.key &&
        JSON.stringify(storedTags) === JSON.stringify(described.tags),
      get: value,
      getEntry:
        entry === undefined
          ? undefined
          : {
              tags: entry.tags,
              createdAt: entry.createdAt,
              freshUntil: entry.freshUntil,
              expiresAt: entry.expiresAt,
              stale: entry.stale,
            },
      hitKeyId: hits[0] ?? null,
      counter: await cache.get(`visits:${key}`),
    };
  } finally {
    off();
  }
}
