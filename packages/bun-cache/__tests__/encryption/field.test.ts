/**
 * `./encryption`: the cache's envelope for one value (bun-security's
 * storage.md §8, PR-D3). A round trip, the binding (purpose, bind parts),
 * tampering, rotation, a wrong key, the separation from the cache's own
 * entries, two known answers (the cache's envelope unchanged by the
 * refactor that exported it, and the field's labels pinned) and the
 * validation, with a negative control where one is meaningful.
 */
import type { FieldContext } from "../../lib/encryption/index";
import { Buffer } from "node:buffer";
import { describe, expect, spyOn, test } from "bun:test";
import { EntryEncryption } from "../../lib/core/encrypt";
import {
  CacheDecryptError,
  FIELD_LABELS,
  fieldKeyId,
  fieldKeyRing,
  openField,
  sealField,
} from "../../lib/encryption/index";
import { CacheDecryptError as RootDecryptError } from "../../lib/index";

/** A ring key of 32 bytes, all `fill`. */
const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const CONTEXT: FieldContext = {
  purpose: "test/store",
  bind: ["docs", "agentKey", "k1", "secret"],
};
const RING = [{ id: "2026-11", key: key(1) }];
const SECRET = "field-sentinel-0123456789";

/** What `openField` threw, or `undefined`. */
function failure(run: () => unknown): CacheDecryptError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof CacheDecryptError) return error;
    throw error;
  }
}

/** Runs `run` with `crypto.getRandomValues` answering a fixed pattern. */
function fixedDraw<T>(run: () => T): T {
  const random = spyOn(crypto, "getRandomValues");
  random.mockImplementation(<A extends ArrayBufferView | null>(array: A) => {
    if (array instanceof Uint8Array) {
      for (let i = 0; i < array.length; i++) array[i] = (i * 37 + 11) & 0xff;
    }
    return array;
  });
  try {
    return run();
  } finally {
    random.mockRestore();
  }
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("a round trip", () => {
  test("a string, bytes and an empty value open to what was sealed", () => {
    for (const value of [SECRET, new Uint8Array([0, 1, 2, 255]), ""]) {
      const sealed = sealField(value, RING, CONTEXT);
      const opened = openField(sealed, RING, CONTEXT);
      expect(opened).toEqual(
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      );
    }
  });

  test("no plaintext in the sealed bytes, and two seals of one value differ", () => {
    const a = sealField(SECRET, RING, CONTEXT);
    const b = sealField(SECRET, RING, CONTEXT);
    expect(Buffer.from(a).toString("latin1")).not.toContain(SECRET);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test("a ring validated once (fieldKeyRing) and a plain ring read each other's", () => {
    const ring = fieldKeyRing(RING);
    expect(ring.primaryKeyId).toBe("2026-11");
    expect(ring.keyIds).toEqual(["2026-11"]);
    expect(
      text(openField(sealField(SECRET, ring, CONTEXT), RING, CONTEXT)),
    ).toBe(SECRET);
    expect(
      text(openField(sealField(SECRET, RING, CONTEXT), ring, CONTEXT)),
    ).toBe(SECRET);
    // Its key bytes do not show.
    expect(JSON.stringify(ring)).not.toContain("1,1,1");
    expect(Object.keys(ring).sort()).toEqual(["keyIds", "primaryKeyId"]);
  });
});

describe("the binding", () => {
  const sealed = sealField(SECRET, RING, CONTEXT);

  test("another row, field, table, purpose or order of parts refuses it (auth)", () => {
    const others: FieldContext[] = [
      { ...CONTEXT, bind: ["docs", "agentKey", "k2", "secret"] },
      { ...CONTEXT, bind: ["docs", "agentKey", "k1", "other"] },
      { ...CONTEXT, bind: ["versions", "agentKey", "k1", "secret"] },
      { ...CONTEXT, bind: ["agentKey", "docs", "k1", "secret"] },
      { ...CONTEXT, bind: ["docs", "agentKey", "k1"] },
      { ...CONTEXT, bind: ["docs", "agentKey", "k1", "secret", ""] },
      { ...CONTEXT, purpose: "test/other" },
    ];
    for (const other of others) {
      expect(failure(() => openField(sealed, RING, other))?.reason).toBe(
        "auth",
      );
    }
  });

  test('the parts are length-prefixed: ["a\\u0000b"] and ["a", "b"] do not open each other', () => {
    const joined = sealField(SECRET, RING, { purpose: "p", bind: ["a\0b"] });
    const split = sealField(SECRET, RING, { purpose: "p", bind: ["a", "b"] });
    expect(
      failure(() => openField(joined, RING, { purpose: "p", bind: ["a", "b"] }))
        ?.reason,
    ).toBe("auth");
    expect(
      failure(() => openField(split, RING, { purpose: "p", bind: ["a\0b"] }))
        ?.reason,
    ).toBe("auth");
    // The control: under its own parts each opens.
    expect(
      text(openField(joined, RING, { purpose: "p", bind: ["a\0b"] })),
    ).toBe(SECRET);
  });

  test("bind defaults to none, which is not the same as one empty part", () => {
    const bare = sealField(SECRET, RING, { purpose: "p" });
    expect(text(openField(bare, RING, { purpose: "p", bind: [] }))).toBe(
      SECRET,
    );
    expect(
      failure(() => openField(bare, RING, { purpose: "p", bind: [""] }))
        ?.reason,
    ).toBe("auth");
  });
});

describe("tampering", () => {
  test("a change to any byte refuses it, never answering other bytes", () => {
    const sealed = sealField(SECRET, RING, CONTEXT);
    const reasons = new Set<string>();
    for (let at = 0; at < sealed.length; at++) {
      const changed = sealed.slice();
      changed[at] ^= 0x01;
      const error = failure(() => openField(changed, RING, CONTEXT));
      expect(error).toBeInstanceOf(CacheDecryptError);
      reasons.add(error!.reason);
    }
    // The magic and version bytes, the cipher id, the key id, the rest.
    expect([...reasons].sort()).toEqual([
      "auth",
      "cipher",
      "malformed",
      "unencrypted",
      "unknown-key",
    ]);
  });

  test("a truncated envelope and bytes that are no envelope are refused", () => {
    const sealed = sealField(SECRET, RING, CONTEXT);
    expect(
      failure(() =>
        openField(sealed.subarray(0, sealed.length - 1), RING, CONTEXT),
      )?.reason,
    ).toBe("auth");
    expect(
      failure(() => openField(sealed.subarray(0, 20), RING, CONTEXT))?.reason,
    ).toBe("malformed");
    expect(
      failure(() => openField(new TextEncoder().encode(SECRET), RING, CONTEXT))
        ?.reason,
    ).toBe("unencrypted");
  });

  test("the error is the package's CacheDecryptError, says it is a field, and shows no value", () => {
    const sealed = sealField(SECRET, RING, CONTEXT);
    sealed[sealed.length - 1] ^= 0x01;
    const error = failure(() => openField(sealed, RING, CONTEXT))!;
    expect(error).toBeInstanceOf(RootDecryptError);
    expect(error.message).toBe(
      'sealed field did not open (auth, key id "2026-11")',
    );
    expect(error.keyId).toBe("2026-11");
  });
});

describe("rotation", () => {
  const OLD = { id: "2026-10", key: key(2) };
  const NEW = { id: "2026-11", key: key(3) };

  test("old values open under the rotated ring, and new seals use its first key", () => {
    const before = sealField(SECRET, [OLD], CONTEXT);
    const rotated = fieldKeyRing([NEW, OLD]);
    expect(text(openField(before, rotated, CONTEXT))).toBe(SECRET);
    const after = sealField(SECRET, rotated, CONTEXT);
    expect(fieldKeyId(before)).toBe("2026-10");
    expect(fieldKeyId(after)).toBe("2026-11");
    // The new key's value does not open under the old ring.
    expect(failure(() => openField(after, [OLD], CONTEXT))?.reason).toBe(
      "unknown-key",
    );
  });

  test("once the old key leaves the ring, what it sealed is refused (unknown-key)", () => {
    const before = sealField(SECRET, [OLD], CONTEXT);
    const error = failure(() => openField(before, [NEW], CONTEXT));
    expect(error?.reason).toBe("unknown-key");
    expect(error?.keyId).toBe("2026-10");
  });
});

describe("a wrong key", () => {
  test("another key under the same id is refused (auth)", () => {
    const sealed = sealField(SECRET, RING, CONTEXT);
    expect(
      failure(() =>
        openField(sealed, [{ id: "2026-11", key: key(9) }], CONTEXT),
      )?.reason,
    ).toBe("auth");
  });

  test("a key shared with a cache never opens the cache's entries, nor the cache a field", () => {
    const hooks = {
      now: () => 0,
      timeout: undefined,
      onProviderError: () => {},
    };
    const cache = new EntryEncryption({ keys: RING }, hooks);
    const entry = cache.seal(
      "docs",
      "k1",
      new TextEncoder().encode(SECRET),
      null,
      [],
    ) as Uint8Array;
    // The same envelope layout, the same key and id: only the labels differ.
    expect(fieldKeyId(entry)).toBe("2026-11");
    expect(failure(() => openField(entry, RING, CONTEXT))?.reason).toBe("auth");
    const field = sealField(SECRET, RING, { purpose: "p", bind: [] });
    expect(() => cache.open("docs", "k1", field)).toThrow(
      "cache entry did not open (auth",
    );
    // The control: the cache opens its own.
    expect(cache.open("docs", "k1", entry)).toBeDefined();
  });
});

describe("known answers", () => {
  test("the cache's entry envelope is byte for byte what it was before ./encryption", () => {
    // Recorded on develop 122c2461, before the envelope's functions took a label.
    const hooks = {
      now: () => 0,
      timeout: undefined,
      onProviderError: () => {},
    };
    const sealed = fixedDraw(
      () =>
        new EntryEncryption(
          {
            keys: [
              { id: "2026-10", key: key(1) },
              { id: "old", key: key(2) },
            ],
            aad: "prod",
          },
          hooks,
        ).seal(
          "app@v3:users",
          "user:42",
          new TextEncoder().encode("entry-bytes"),
          1_700_000_000_000,
          ["t1", "tag-two"],
        ) as Uint8Array,
    );
    expect(Buffer.from(sealed).toString("hex")).toBe(
      "4245010107323032362d31300b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf24a589f9124f74163a7fc56f0474a033b707e74e5c84156c32f35da5d8d5054218343f14df0831ab9457f3a7ab4b6bde79934bc",
    );
  });

  test("a field's envelope is pinned: its labels are persisted", () => {
    const sealed = fixedDraw(() =>
      sealField("field-value", [{ id: "2026-10", key: key(1) }], {
        purpose: "test/kat",
        bind: ["docs", "agentKey", "k1", "secret"],
      }),
    );
    expect(Buffer.from(sealed).toString("hex")).toBe(
      "4245010107323032362d31300b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf284887de9c3641e609239a20ed2582076850f24d78fef3ab0417265",
    );
    expect(FIELD_LABELS).toEqual({
      aad: "bun-cache/field/1",
      hkdf: "bun-cache/field/1/aes-256-gcm",
      field: "field",
    });
  });
});

describe("validation", () => {
  test("a malformed ring is a TypeError that never shows the key", () => {
    const secretish = "s3cr3t-passphrase-not-a-key";
    for (const ring of [
      [],
      [{ id: "bad id", key: key(1) }],
      [{ id: "a", key: secretish }],
      [
        { id: "a", key: key(1) },
        { id: "a", key: key(2) },
      ],
    ]) {
      expect(() => fieldKeyRing(ring)).toThrow(TypeError);
      expect(() => sealField(SECRET, ring, CONTEXT)).toThrow(TypeError);
      try {
        fieldKeyRing(ring);
      } catch (error) {
        expect((error as Error).message).not.toContain(secretish);
      }
    }
  });

  test("a malformed purpose, bind or value is a TypeError", () => {
    const bad: FieldContext[] = [
      { purpose: "" },
      { purpose: "has space" },
      { purpose: "x".repeat(129) },
      { purpose: "p", bind: [1 as unknown as string] },
    ];
    for (const context of bad) {
      expect(() => sealField(SECRET, RING, context)).toThrow(TypeError);
      expect(() => openField(new Uint8Array(80), RING, context)).toThrow(
        TypeError,
      );
    }
    expect(() => sealField(42 as unknown as string, RING, CONTEXT)).toThrow(
      TypeError,
    );
    expect(() =>
      openField("x" as unknown as Uint8Array, RING, CONTEXT),
    ).toThrow(TypeError);
  });

  test("fieldKeyId reads only a well-formed envelope", () => {
    expect(fieldKeyId(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(fieldKeyId(sealField(SECRET, RING, CONTEXT))).toBe("2026-11");
  });
});
