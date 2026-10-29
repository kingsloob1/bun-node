/**
 * The stored format, read the way the README tells a reader in another
 * language to read it ("Encryption at rest" → "The format", and "Hiding
 * names"): the envelope's fields, the per-entry key and the AAD, the sealed
 * body, the entry header inside it (format 1, and format 2 when a
 * compressor needs one), and the stored names.
 *
 * Everything is decoded **here**, from the README's text, with `node:crypto`
 * (HKDF-SHA-256, HMAC-SHA-256, AES-256-GCM), `node:zlib` and `bun:jsc`: the
 * library is used only through its public API, to write entries and to
 * answer `describeKey`, and the bytes come from the driver's own `get`. So a
 * drift between the code and the documented format fails here, whichever of
 * the two moved. Every documented constant the decoder uses is in
 * {@link README}.
 */
import { deserialize } from "bun:jsc";
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
} from "node:crypto";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  zstdDecompressSync,
} from "node:zlib";
import type {
  CacheCipher,
  CacheDriver,
  CompressOptions,
  StoredEntry,
} from "../../lib/index";
import { createCache, memoryDriver } from "../../lib/index";

/** The README's documented constants, as a reader would copy them out. */
const README = {
  /** The envelope's magic. */
  envelopeMagic: "BE",
  /** The envelope's version. */
  envelopeVersion: 1,
  /** The built-in cipher's id. */
  builtInCipherId: 1,
  /** Where the key id's length is: after magic (2), version (1) and cipher id (1). */
  keyIdLengthAt: 4,
  /** The salt's length. */
  saltBytes: 16,
  /** The nonce's length. */
  nonceBytes: 12,
  /** The GCM tag's length. */
  gcmTagBytes: 16,
  /** The HKDF `info` of a ring key's K. */
  encInfo: "bun-cache/enc/1/aes-256-gcm",
  /** The per-entry key's label: K_salt = HMAC-SHA-256(K, "entry" | salt | 0x01). */
  entryLabel: "entry",
  /** The AAD's label. */
  aadLabel: "bun-cache/enc/1",
  /** The sealed body's version. */
  sealedBodyVersion: 1,
  /** The entry header's magic. */
  entryMagic: "BC",
  /** The HKDF `info` of the names key. */
  namesInfo: "bun-cache/names/1",
  /** The names hash's labels. */
  nameLabels: { namespace: "ns", key: "key", tag: "tag" },
  /** A stored name's length, in hex characters. */
  nameHexChars: 32,
  /** The built-in cipher's overhead: 49 + the key id's length + 11 + per tag 2 + its UTF-8 length. */
  overhead: { envelope: 49, body: 11, perTag: 2 },
  /** The codec ids. */
  codecs: { structured: 1, json: 2, raw: 3 },
  /** The compressor ids. */
  compressors: { none: 0, zstd: 1, gzip: 2, br: 3, deflate: 4 },
  /** The flag bits. */
  flags: { zstd: 1, gzip: 2, counter: 4, negative: 8, rawString: 16 },
} as const;

/** A ring key: 32 fixed test bytes (this file's own; never a real secret). */
const RING_KEY = new Uint8Array(32).map((_, index) => index * 7 + 1);

/** The names key: 32 other fixed test bytes. */
const NAMES_KEY = new Uint8Array(32).map((_, index) => 255 - index * 3);

/** The ring key's id. */
const KEY_ID = "2026-10";

/** `encrypt.aad`, bound into every entry. */
const AAD = "prod";

const encoder = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });

/** The envelope's fields, as "The format" lays them out. */
interface Envelope {
  magic: string;
  version: number;
  cipherId: number;
  keyId: string;
  salt: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  gcmTag: Uint8Array;
  /** The envelope's bytes up to the ciphertext (the AAD's last part). */
  prefix: Uint8Array;
}

/** "envelope = "BE" | u8 1 | u8 cipher id | u8 L | key id | salt | nonce | ciphertext | tag". */
function parseEnvelope(bytes: Uint8Array): Envelope {
  const length = bytes[README.keyIdLengthAt];
  const saltAt = README.keyIdLengthAt + 1 + length;
  const nonceAt = saltAt + README.saltBytes;
  const bodyAt = nonceAt + README.nonceBytes;
  const tagAt = bytes.length - README.gcmTagBytes;
  return {
    magic: String.fromCharCode(bytes[0], bytes[1]),
    version: bytes[2],
    cipherId: bytes[3],
    keyId: strict.decode(bytes.subarray(README.keyIdLengthAt + 1, saltAt)),
    salt: bytes.subarray(saltAt, nonceAt),
    nonce: bytes.subarray(nonceAt, bodyAt),
    ciphertext: bytes.subarray(bodyAt, tagAt),
    gcmTag: bytes.subarray(tagAt),
    prefix: bytes.subarray(0, bodyAt),
  };
}

/** "AAD = label 0x00 | full namespace 0x00 | full key 0x00 | aad 0x00 | prefix". */
function documentedAad(
  namespace: string,
  key: string,
  aad: string,
  prefix: Uint8Array,
): Uint8Array {
  const zero = new Uint8Array([0]);
  return new Uint8Array(
    Buffer.concat([
      encoder.encode(README.aadLabel),
      zero,
      encoder.encode(namespace),
      zero,
      encoder.encode(key),
      zero,
      encoder.encode(aad),
      zero,
      prefix,
    ]),
  );
}

/** K, K_salt and AES-256-GCM, as "The format" writes them: answers the sealed body. */
function openEnvelope(
  envelope: Envelope,
  namespace: string,
  key: string,
  aad: string,
  ringKey: Uint8Array = RING_KEY,
): Uint8Array {
  const k = new Uint8Array(
    hkdfSync("sha256", ringKey, new Uint8Array(0), README.encInfo, 32),
  );
  const kSalt = createHmac("sha256", k)
    .update(README.entryLabel)
    .update(envelope.salt)
    .update(new Uint8Array([1]))
    .digest();
  const decipher = createDecipheriv("aes-256-gcm", kSalt, envelope.nonce);
  decipher.setAAD(documentedAad(namespace, key, aad, envelope.prefix));
  decipher.setAuthTag(envelope.gcmTag);
  return new Uint8Array(
    Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]),
  );
}

/** "sealed body = u8 1 | f64 LE expiresAt (-1: none) | u16 LE tag count | per tag: u16 LE length, UTF-8 | the entry". */
function parseSealedBody(body: Uint8Array): {
  version: number;
  expiresAt: number | null;
  tags: string[];
  entry: Uint8Array;
} {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const expiresAt = view.getFloat64(1, true);
  const count = view.getUint16(9, true);
  const tags: string[] = [];
  let at = 11;
  for (let index = 0; index < count; index++) {
    const length = view.getUint16(at, true);
    tags.push(strict.decode(body.subarray(at + 2, at + 2 + length)));
    at += 2 + length;
  }
  return {
    version: body[0],
    expiresAt: expiresAt === -1 ? null : expiresAt,
    tags,
    entry: body.subarray(at),
  };
}

/** One entry header, as "The format" lays out formats 1 and 2. */
interface EntryHeader {
  magic: string;
  format: number;
  codec: number;
  flags: number;
  /** Format 2's byte; for format 1, read from flags bits 0–1. */
  compressor: number;
  createdAt: number;
  freshUntil: number | null;
  loadMs: number;
  key: string;
  payload: Uint8Array;
}

/** "format 1 = "BC" | 1 | codec | flags | f64 createdAt | f64 freshUntil | f64 loadMs | u32 key length | key | payload"; format 2 adds the compressor byte after the flags. */
function parseEntry(bytes: Uint8Array): EntryHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = bytes[2];
  const flags = bytes[4];
  const at = format === 2 ? 6 : 5;
  const compressor =
    format === 2
      ? bytes[5]
      : flags & README.flags.zstd
        ? README.compressors.zstd
        : flags & README.flags.gzip
          ? README.compressors.gzip
          : README.compressors.none;
  const keyLength = view.getUint32(at + 24, true);
  const keyAt = at + 28;
  const freshUntil = view.getFloat64(at + 8, true);
  return {
    magic: String.fromCharCode(bytes[0], bytes[1]),
    format,
    codec: bytes[3],
    flags,
    compressor,
    createdAt: view.getFloat64(at, true),
    freshUntil: freshUntil === -1 ? null : freshUntil,
    loadMs: view.getFloat64(at + 16, true),
    key: strict.decode(bytes.subarray(keyAt, keyAt + keyLength)),
    payload: bytes.subarray(keyAt + keyLength),
  };
}

/** The payload's codec bytes: decompressed by the header's compressor id. */
function decompress(header: EntryHeader): Uint8Array {
  switch (header.compressor) {
    case README.compressors.none:
      return header.payload;
    case README.compressors.zstd:
      return new Uint8Array(zstdDecompressSync(header.payload));
    case README.compressors.gzip:
      return new Uint8Array(gunzipSync(header.payload));
    case README.compressors.br:
      return new Uint8Array(brotliDecompressSync(header.payload));
    case README.compressors.deflate:
      return new Uint8Array(inflateRawSync(header.payload));
    default:
      throw new Error(`compressor ${header.compressor} is not in the README`);
  }
}

/** The value, by the header's codec ("1 structured (bun:jsc), 2 json, 3 raw"). */
function decodeValue(header: EntryHeader): unknown {
  const bytes = decompress(header);
  switch (header.codec) {
    case README.codecs.structured:
      return deserialize(bytes);
    case README.codecs.json:
      return JSON.parse(strict.decode(bytes));
    case README.codecs.raw:
      return header.flags & README.flags.rawString
        ? strict.decode(bytes)
        : bytes;
    default:
      throw new Error(`codec ${header.codec} is not in the README`);
  }
}

/** "Hiding names": hex(HMAC-SHA-256(K_names, label 0x00 | full namespace [0x00 | name]))[0..32]. */
function nameHash(
  kind: "namespace" | "key" | "tag",
  namespace: string,
  name?: string,
): string {
  const kNames = new Uint8Array(
    hkdfSync("sha256", NAMES_KEY, new Uint8Array(0), README.namesInfo, 32),
  );
  const hmac = createHmac("sha256", kNames).update(
    `${README.nameLabels[kind]}\0${namespace}`,
  );
  if (name !== undefined) {
    hmac.update(`\0${name}`);
  }
  return hmac.digest("hex").slice(0, README.nameHexChars);
}

/** The README's overhead of the built-in cipher, for `tags` under `keyId`. */
function documentedOverhead(keyId: string, tags: readonly string[]): number {
  return (
    README.overhead.envelope +
    encoder.encode(keyId).byteLength +
    README.overhead.body +
    tags.reduce(
      (sum, tag) =>
        sum + README.overhead.perTag + encoder.encode(tag).byteLength,
      0,
    )
  );
}

/** A memory driver and an encrypted, name-hashing cache over it. */
function sealedCache(
  options: {
    namespace?: string;
    version?: string;
    compress?: CompressOptions;
  } = {},
): { driver: CacheDriver; cache: ReturnType<typeof createCache> } {
  const driver = memoryDriver();
  const cache = createCache({
    driver,
    namespace: options.namespace ?? "app",
    version: options.version,
    sweepInterval: 0,
    ...(options.compress === undefined ? {} : { compress: options.compress }),
    encrypt: {
      keys: [{ id: KEY_ID, key: RING_KEY }],
      aad: AAD,
      hashNames: { key: NAMES_KEY },
    },
  });
  return { driver, cache };
}

/** The driver's stored entry at `describeKey`'s names. */
async function storedAt(
  driver: CacheDriver,
  described: { namespace: string; key: string },
): Promise<StoredEntry> {
  const stored = await driver.get(described.namespace, described.key);
  expect(stored).toBeDefined();
  return stored!;
}

describe("the documented format: an encrypted entry, read by hand", () => {
  test("the envelope's fields are where the README puts them", async () => {
    const { driver, cache } = sealedCache();
    try {
      await cache.set("user:42", { name: "Ada" }, { tags: ["users", "org:7"] });
      const stored = await storedAt(
        driver,
        cache.describeKey("user:42", ["users", "org:7"]),
      );
      const envelope = parseEnvelope(stored.value);
      expect({
        magic: envelope.magic,
        version: envelope.version,
        cipherId: envelope.cipherId,
        keyIdLength: stored.value[README.keyIdLengthAt],
        keyId: envelope.keyId,
        salt: envelope.salt.byteLength,
        nonce: envelope.nonce.byteLength,
        gcmTag: envelope.gcmTag.byteLength,
      }).toEqual({
        magic: README.envelopeMagic,
        version: README.envelopeVersion,
        cipherId: README.builtInCipherId,
        keyIdLength: KEY_ID.length,
        keyId: KEY_ID,
        salt: README.saltBytes,
        nonce: README.nonceBytes,
        gcmTag: README.gcmTagBytes,
      });
    } finally {
      await cache.close();
    }
  });

  test("HKDF, K_salt and AES-256-GCM over the documented AAD open it; the sealed body and entry header read back", async () => {
    const { driver, cache } = sealedCache();
    try {
      const value = { name: "Ada", roles: ["admin"], since: 2019 };
      const tags = ["users", "org:7"];
      await cache.set("user:42", value, { ttl: 60_000, tags });
      const stored = await storedAt(driver, cache.describeKey("user:42", tags));
      const envelope = parseEnvelope(stored.value);
      // The plaintext full namespace and key, also under hashNames.
      const body = parseSealedBody(
        openEnvelope(envelope, "app", "user:42", AAD),
      );
      expect(body.version).toBe(README.sealedBodyVersion);
      expect(body.tags).toEqual(tags);
      // The sealed expiry is the one the driver was given in clear.
      expect(body.expiresAt).toBe(stored.expiresAt);
      const header = parseEntry(body.entry);
      expect({
        magic: header.magic,
        format: header.format,
        codec: header.codec,
        compressor: header.compressor,
        key: header.key,
      }).toEqual({
        magic: README.entryMagic,
        format: 1,
        codec: README.codecs.structured,
        compressor: README.compressors.none,
        key: "user:42",
      });
      const entry = await cache.getEntry("user:42");
      expect(header.createdAt).toBe(entry!.createdAt);
      expect(header.freshUntil).toBe(entry!.freshUntil);
      expect(decodeValue(header)).toEqual(value);
      // The overhead the README gives.
      expect(stored.value.byteLength - body.entry.byteLength).toBe(
        documentedOverhead(KEY_ID, tags),
      );
    } finally {
      await cache.close();
    }
  });

  test("an untagged entry with no expiry: expiresAt -1, no tags, freshUntil -1", async () => {
    const { driver, cache } = sealedCache();
    try {
      await cache.set("config", "on", { ttl: null });
      const stored = await storedAt(driver, cache.describeKey("config"));
      const body = parseSealedBody(
        openEnvelope(parseEnvelope(stored.value), "app", "config", AAD),
      );
      expect(body.expiresAt).toBeNull();
      expect(body.tags).toEqual([]);
      const header = parseEntry(body.entry);
      expect(header.freshUntil).toBeNull();
      expect(decodeValue(header)).toBe("on");
      expect(stored.value.byteLength - body.entry.byteLength).toBe(
        documentedOverhead(KEY_ID, []),
      );
    } finally {
      await cache.close();
    }
  });

  test("the AAD binds the documented parts: another aad, namespace or key does not open", async () => {
    const { driver, cache } = sealedCache();
    try {
      await cache.set("user:42", 1);
      const envelope = parseEnvelope(
        (await storedAt(driver, cache.describeKey("user:42"))).value,
      );
      expect(() => openEnvelope(envelope, "app", "user:42", AAD)).not.toThrow();
      expect(() =>
        openEnvelope(envelope, "app", "user:42", "staging"),
      ).toThrow();
      expect(() => openEnvelope(envelope, "app2", "user:42", AAD)).toThrow();
      expect(() => openEnvelope(envelope, "app", "user:43", AAD)).toThrow();
      expect(() =>
        openEnvelope(envelope, "app", "user:42", AAD, new Uint8Array(32)),
      ).toThrow();
    } finally {
      await cache.close();
    }
  });

  test("the full namespace is the versioned chain, plaintext: app@v3:users", async () => {
    const { driver, cache } = sealedCache({ version: "v3" });
    try {
      const users = cache.namespace("users");
      await users.set("user:1", "Grace", { tags: ["users"] });
      const described = users.describeKey("user:1", ["users"]);
      expect(described).toEqual({
        namespace: nameHash("namespace", "app@v3:users"),
        key: nameHash("key", "app@v3:users", "user:1"),
        tags: [nameHash("tag", "app@v3:users", "users")],
      });
      const stored = await storedAt(driver, described);
      const body = parseSealedBody(
        openEnvelope(
          parseEnvelope(stored.value),
          "app@v3:users",
          "user:1",
          AAD,
        ),
      );
      expect(decodeValue(parseEntry(body.entry))).toBe("Grace");
    } finally {
      await cache.close();
    }
  });

  for (const [algorithm, format, compressor] of [
    ["zstd", 1, README.compressors.zstd],
    ["gzip", 1, README.compressors.gzip],
    ["br", 2, README.compressors.br],
    ["deflate", 2, README.compressors.deflate],
  ] as const) {
    test(`a compressed entry (${algorithm}): format ${format}, compressor ${compressor}, decompressed by hand`, async () => {
      const { driver, cache } = sealedCache({
        compress: { algorithm, threshold: 64 },
      });
      try {
        const value = { text: "the cache stores this line once. ".repeat(40) };
        await cache.set("page:1", value);
        const stored = await storedAt(driver, cache.describeKey("page:1"));
        const header = parseEntry(
          parseSealedBody(
            openEnvelope(parseEnvelope(stored.value), "app", "page:1", AAD),
          ).entry,
        );
        expect({
          format: header.format,
          compressor: header.compressor,
        }).toEqual({ format, compressor });
        // Format 2 keeps flags bits 0–1 zero.
        if (format === 2) {
          expect(header.flags & (README.flags.zstd | README.flags.gzip)).toBe(
            0,
          );
        }
        expect(decodeValue(header)).toEqual(value);
      } finally {
        await cache.close();
      }
    });
  }
});

describe("the documented format: stored names", () => {
  test("namespace, key and tag hashes match describeKey and the driver's entry", async () => {
    const { driver, cache } = sealedCache();
    try {
      const tags = ["users", "org:7"];
      await cache.set("user:ada@example.com", { ok: true }, { tags });
      const described = cache.describeKey("user:ada@example.com", tags);
      expect(described).toEqual({
        namespace: nameHash("namespace", "app"),
        key: nameHash("key", "app", "user:ada@example.com"),
        tags: tags.map((tag) => nameHash("tag", "app", tag)),
      });
      // The driver was handed exactly those names: the entry is found at
      // them, and carries the hashed tags in clear.
      const stored = await storedAt(driver, described);
      expect(stored.key).toBe(described.key);
      expect([...stored.tags]).toEqual(described.tags);
      expect(described.namespace).toMatch(/^[\da-f]{32}$/);
    } finally {
      await cache.close();
    }
  });

  test("a counter's name is hashed as a key, and its value is a plaintext integer", async () => {
    const { driver, cache } = sealedCache();
    try {
      expect(await cache.increment("hits:/", 3)).toBe(3);
      const counter = await driver.getCounter!(
        nameHash("namespace", "app"),
        nameHash("key", "app", "hits:/"),
      );
      expect(counter?.value).toBe(3);
    } finally {
      await cache.close();
    }
  });
});

describe("the documented format: the rest of 'The format'", () => {
  test("a user cipher's entry is bytes 0–3, then its seal's output; its AAD ends with those four bytes", async () => {
    const seen: Uint8Array[] = [];
    const cipher: CacheCipher = {
      id: 200,
      seal: (plaintext, context) => {
        seen.push(context.aad);
        return plaintext.slice();
      },
      open: (sealed) => sealed.slice(),
    };
    const driver = memoryDriver();
    const cache = createCache({
      driver,
      namespace: "app",
      sweepInterval: 0,
      encrypt: { cipher, aad: AAD },
    });
    try {
      await cache.set("user:42", "x", { tags: ["users"] });
      const stored = (await driver.get("app", "user:42"))!;
      const prefix = stored.value.subarray(0, 4);
      expect([...prefix]).toEqual([
        README.envelopeMagic.charCodeAt(0),
        README.envelopeMagic.charCodeAt(1),
        README.envelopeVersion,
        200,
      ]);
      expect(Buffer.from(seen[0])).toEqual(
        Buffer.from(documentedAad("app", "user:42", AAD, prefix)),
      );
      // This cipher's output is the sealed body itself.
      const body = parseSealedBody(stored.value.subarray(4));
      expect(body.tags).toEqual(["users"]);
      expect(decodeValue(parseEntry(body.entry))).toBe("x");
    } finally {
      await cache.close();
    }
  });

  test("a plain cache stores the entry alone; codec json is plain JSON; a long key is # + its SHA-256 hex", async () => {
    const driver = memoryDriver();
    const cache = createCache({
      driver,
      namespace: "app",
      sweepInterval: 0,
      codec: "json",
    });
    try {
      const long = `report:${"q".repeat(250)}`;
      await cache.set(long, { total: 7 }, { tags: ["reports"] });
      const storedKey = `#${createHash("sha256").update(long).digest("hex")}`;
      expect(cache.describeKey(long, ["reports"])).toEqual({
        namespace: "app",
        key: storedKey,
        tags: ["reports"],
      });
      const stored = (await driver.get("app", storedKey))!;
      const header = parseEntry(stored.value);
      expect({
        magic: header.magic,
        format: header.format,
        codec: header.codec,
        key: header.key,
      }).toEqual({
        magic: README.entryMagic,
        format: 1,
        codec: README.codecs.json,
        key: long,
      });
      expect(strict.decode(header.payload)).toBe('{"total":7}');
      expect(decodeValue(header)).toEqual({ total: 7 });
    } finally {
      await cache.close();
    }
  });
});
