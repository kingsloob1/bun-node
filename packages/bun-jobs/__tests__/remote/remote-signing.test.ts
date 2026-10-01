import type { RemoteNonceStore } from "@kingsleyweb/bun-jobs/remote";
import type { HmacSha256 } from "../../lib/remote/mac";
import {
  createRemoteNonceCache,
  REMOTE_SIGNATURE_WINDOW_MS,
  signEnvelope,
  verifyEnvelope,
} from "@kingsleyweb/bun-jobs/remote";
import { describe, expect, it } from "bun:test";
import { nodeHmacSha256 } from "../../lib/remote/host/mac";
import { constantTimeEqual, subtleHmacSha256 } from "../../lib/remote/mac";
import { signEnvelopeWith, verifyEnvelopeWith } from "../../lib/remote/signing";
import { ConfigError } from "../../lib/shared/errors";

/**
 * `signEnvelope`/`verifyEnvelope`: `worker-runtimes.md` §5.6. Every clock is
 * passed in (`now`), so the window is tested to the millisecond without
 * waiting or patching `Date`.
 */

const SECRET = "bun-jobs-test-secret";
/** 2026-09-21T13:33:20Z: a fixed signing instant, in ms. */
const T0 = 1_790_000_000_000;
const BODY = '{"v":1,"op":"ping","id":"p1"}';

/** One byte of a string changed, for tampering. */
function flip(text: string, at: number): string {
  const code = text.charCodeAt(at);
  return text.slice(0, at) + String.fromCharCode(code ^ 1) + text.slice(at + 1);
}

/** A header with its `t` replaced. */
function withT(header: string, t: number): string {
  return header.replace(/^t=\d+/, `t=${t}`);
}

describe("known-answer vectors", () => {
  // Computed with `openssl dgst -sha256 -hmac`, not with this code, so a bug
  // shared by both MAC implementations cannot hide here.
  const vectors: {
    name: string;
    body: string | null;
    id?: string;
    hex: string;
  }[] = [
    {
      name: "a ping envelope",
      body: BODY,
      hex: "897f3c0ec02c9498f706649bd74361ffb652c3e05dfdb7b91959caf586867d22",
    },
    {
      name: 'an empty POST body: `t "."` alone',
      body: "",
      hex: "a8174e7074496eaafd6db7b2e40ea0df564ecf8db5d9e3c95f94e3e88f428aff",
    },
    {
      name: 'a bodyless request (the handshake GET): `t "." id`',
      body: null,
      id: "hs_01JB7Q2M9S0P",
      hex: "d4d0c3a3238da640d418d84ad970fd5e567ee40a24709eb86fb3452eca07159d",
    },
    {
      name: "a body outside ASCII, signed as its UTF-8",
      body: '{"name":"café ☕"}',
      hex: "b835fabfe50deb16f36af04fa8f95fc2758708c505e568e70ebae3b637e90180",
    },
  ];

  for (const mac of [
    { name: "crypto.subtle", fn: subtleHmacSha256 },
    { name: "node:crypto", fn: nodeHmacSha256 },
  ] as const) {
    for (const vector of vectors) {
      it(`${mac.name}: ${vector.name}`, async () => {
        expect(
          await signEnvelopeWith(mac.fn, vector.body, {
            secret: SECRET,
            now: T0,
            id: vector.id,
          }),
        ).toBe(`t=1790000000,v1=${vector.hex}`);
      });
    }
  }

  it("the public signEnvelope is the crypto.subtle one", async () => {
    expect(await signEnvelope(BODY, { secret: SECRET, now: T0 })).toBe(
      `t=1790000000,v1=${vectors[0]!.hex}`,
    );
  });

  it("one flipped body byte gives another signature (the control)", async () => {
    const header = await signEnvelope(flip(BODY, 10), {
      secret: SECRET,
      now: T0,
    });
    expect(header).not.toContain(vectors[0]!.hex);
  });

  it("signs a string, its bytes and its ArrayBuffer identically", async () => {
    const unicode = vectors.find((vector) =>
      vector.name.startsWith("a body outside"),
    )!;
    const bytes = new TextEncoder().encode(unicode.body!);
    const signed = await Promise.all([
      signEnvelope(unicode.body!, { secret: SECRET, now: T0 }),
      signEnvelope(bytes, { secret: SECRET, now: T0 }),
      signEnvelope(bytes.slice().buffer, { secret: SECRET, now: T0 }),
    ]);
    expect(new Set(signed).size).toBe(1);
  });

  it("truncates the clock to whole seconds", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 + 999 });
    expect(header.startsWith("t=1790000000,v1=")).toBe(true);
  });
});

describe("round trips", () => {
  it("verifies what it signed, naming the key and the timestamp", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(
      await verifyEnvelope(BODY, header, { secret: SECRET, now: T0 }),
    ).toEqual({ ok: true, timestamp: 1_790_000_000, keyIndex: 0 });
  });

  it("crosses the seam both ways: node:crypto signs, crypto.subtle verifies, and back", async () => {
    const byNode = await signEnvelopeWith(nodeHmacSha256, BODY, {
      secret: SECRET,
      now: T0,
    });
    const bySubtle = await signEnvelopeWith(subtleHmacSha256, BODY, {
      secret: SECRET,
      now: T0,
    });
    expect(
      (
        await verifyEnvelopeWith(subtleHmacSha256, BODY, byNode, {
          secret: SECRET,
          now: T0,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await verifyEnvelopeWith(nodeHmacSha256, BODY, bySubtle, {
          secret: SECRET,
          now: T0,
        })
      ).ok,
    ).toBe(true);
  });

  it("verifies the raw bytes received, as bytes", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    const received = new TextEncoder().encode(BODY);
    expect(
      (await verifyEnvelope(received, header, { secret: SECRET, now: T0 })).ok,
    ).toBe(true);
  });

  it("refuses a re-serialised body: the bytes, not the object, are signed", async () => {
    const sent = '{ "v": 1, "op": "ping", "id": "p1" }';
    const header = await signEnvelope(sent, { secret: SECRET, now: T0 });
    const reserialised = JSON.stringify(JSON.parse(sent));
    expect(reserialised).toBe(BODY);
    expect(
      (await verifyEnvelope(reserialised, header, { secret: SECRET, now: T0 }))
        .ok,
    ).toBe(false);
  });

  it("ignores an element of a scheme it does not know (a future v2)", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    expect(
      (
        await verifyEnvelope(BODY, `${header},v2=whatever`, {
          secret: SECRET,
          now: T0,
        })
      ).ok,
    ).toBe(true);
  });

  it("accepts any one matching v1 among several", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    const [t, v1] = header.split(",");
    const other = `v1=${"0".repeat(64)}`;
    expect(
      (
        await verifyEnvelope(BODY, `${t},${other},${v1}`, {
          secret: SECRET,
          now: T0,
        })
      ).ok,
    ).toBe(true);
  });
});

describe("tampering", () => {
  it("a changed body byte is SIGNATURE_INVALID", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    for (const at of [0, 10, BODY.length - 1]) {
      expect(
        await verifyEnvelope(flip(BODY, at), header, {
          secret: SECRET,
          now: T0,
        }),
      ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID", status: 401 });
    }
  });

  it("a changed envelope id (the body's nonce) is SIGNATURE_INVALID", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    const otherId = BODY.replace('"p1"', '"p2"');
    expect(
      await verifyEnvelope(otherId, header, { secret: SECRET, now: T0 }),
    ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("a changed timestamp is SIGNATURE_INVALID, not a timestamp failure", async () => {
    // Moved inside the window, so only the MAC can catch it.
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    for (const t of [1_789_999_999, 1_790_000_001, 1_790_000_060]) {
      expect(
        await verifyEnvelope(BODY, withT(header, t), {
          secret: SECRET,
          now: T0,
        }),
      ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
    }
  });

  it("a changed MAC digit is SIGNATURE_INVALID", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    expect(
      await verifyEnvelope(BODY, flip(header, header.length - 1), {
        secret: SECRET,
        now: T0,
      }),
    ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("the wrong key is SIGNATURE_INVALID", async () => {
    const header = await signEnvelope(BODY, { secret: "another", now: T0 });
    expect(
      await verifyEnvelope(BODY, header, { secret: SECRET, now: T0 }),
    ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("checks the MAC before the clock: a forged stale request is INVALID, never TIMESTAMP", async () => {
    const header = await signEnvelope(BODY, { secret: "another", now: T0 });
    expect(
      await verifyEnvelope(BODY, header, {
        secret: SECRET,
        now: T0 + 3_600_000,
      }),
    ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("no header, or one that does not parse, is SIGNATURE_MISSING", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    const v1 = header.split(",")[1]!;
    const malformed = [
      null,
      undefined,
      "",
      "garbage",
      v1,
      "t=1790000000",
      `t=abc,${v1}`,
      `t=-1790000000,${v1}`,
      `t=1790000000,t=1790000000,${v1}`,
      "t=1790000000,v1=abcd",
      `t=1790000000,v1=${"g".repeat(64)}`,
      `t=1790000000,${v1},noequals`,
      `t=1790000000,${v1},${"x".repeat(1024)}=1`,
      `t=1790000000,${Array.from({ length: 9 }).fill(v1).join(",")}`,
    ];
    for (const bad of malformed) {
      expect({
        bad,
        result: await verifyEnvelope(BODY, bad, { secret: SECRET, now: T0 }),
      }).toMatchObject({
        bad,
        result: { ok: false, code: "SIGNATURE_MISSING", status: 401 },
      });
    }
  });

  it("the comparison is constant-time and length-checked", () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([1, 2]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});

describe("the replay window, both ways", () => {
  const W = REMOTE_SIGNATURE_WINDOW_MS;

  it("is 300 s", () => {
    expect(W).toBe(300_000);
  });

  it("accepts the window's edge on both sides and refuses a millisecond past it", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    const at = async (now: number) =>
      verifyEnvelope(BODY, header, { secret: SECRET, now });
    expect((await at(T0 + W)).ok).toBe(true);
    expect((await at(T0 - W)).ok).toBe(true);
    expect(await at(T0 + W + 1)).toMatchObject({
      ok: false,
      code: "SIGNATURE_TIMESTAMP",
      status: 401,
      skewMs: W + 1,
    });
    // The future-dated direction: a one-sided `now - t > window` check would
    // accept this one, and so a captured request forever.
    expect(await at(T0 - W - 1)).toMatchObject({
      ok: false,
      code: "SIGNATURE_TIMESTAMP",
      skewMs: -(W + 1),
    });
  });

  it("refuses a request dated a year ahead (the one-sided check's hole)", async () => {
    const future = await signEnvelope(BODY, {
      secret: SECRET,
      now: T0 + 365 * 86_400_000,
    });
    expect(
      await verifyEnvelope(BODY, future, { secret: SECRET, now: T0 }),
    ).toMatchObject({ ok: false, code: "SIGNATURE_TIMESTAMP" });
  });

  it("can be narrowed", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    const options = { secret: SECRET, windowMs: 60_000 };
    expect(
      (await verifyEnvelope(BODY, header, { ...options, now: T0 + 60_000 })).ok,
    ).toBe(true);
    expect(
      await verifyEnvelope(BODY, header, { ...options, now: T0 + 60_001 }),
    ).toMatchObject({ ok: false, code: "SIGNATURE_TIMESTAMP" });
  });

  it("cannot be widened, or be empty", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    for (const windowMs of [W + 1, 0, -1, 1.5, Number.NaN]) {
      await expect(
        verifyEnvelope(BODY, header, { secret: SECRET, now: T0, windowMs }),
      ).rejects.toBeInstanceOf(ConfigError);
    }
  });
});

describe("the nonce cache", () => {
  it("refuses the same signed request twice", async () => {
    const nonces = createRemoteNonceCache();
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    const options = { secret: SECRET, now: T0, nonces };
    expect((await verifyEnvelope(BODY, header, options)).ok).toBe(true);
    expect(await verifyEnvelope(BODY, header, options)).toMatchObject({
      ok: false,
      code: "REPLAYED",
      status: 401,
    });
  });

  it("without a cache, the same request verifies twice (the control)", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    for (let i = 0; i < 2; i++) {
      expect(
        (await verifyEnvelope(BODY, header, { secret: SECRET, now: T0 })).ok,
      ).toBe(true);
    }
  });

  it("accepts a transport retry, which is new bytes under a new envelope id", async () => {
    const nonces = createRemoteNonceCache();
    const retry = BODY.replace('"p1"', '"p1-retry"');
    for (const body of [BODY, retry]) {
      const header = await signEnvelope(body, { secret: SECRET, now: T0 });
      expect(
        (
          await verifyEnvelope(body, header, {
            secret: SECRET,
            now: T0,
            nonces,
          })
        ).ok,
      ).toBe(true);
    }
  });

  it("refuses a replay however its header is rearranged", async () => {
    const nonces = createRemoteNonceCache();
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    const [t, v1] = header.split(",");
    const options = { secret: SECRET, now: T0 + 1_000, nonces };
    expect((await verifyEnvelope(BODY, header, options)).ok).toBe(true);
    for (const variant of [
      `${v1},${t}`,
      `${t},v1=${"0".repeat(64)},${v1}`,
      `${t}, ${v1}`,
      `${t},${v1},v2=x`,
    ]) {
      expect(await verifyEnvelope(BODY, variant, options)).toMatchObject({
        ok: false,
        code: "REPLAYED",
      });
    }
  });

  it("refuses a replay that drops one of a rotation's two signatures", async () => {
    // A signer mid-rotation may send one v1 per key. Stripping one leaves a
    // header that verifies under the other key: the nonce must not depend on
    // which key matched.
    const nonces = createRemoteNonceCache();
    const byNew = await signEnvelope(BODY, { secret: "new", now: T0 });
    const byOld = await signEnvelope(BODY, { secret: "old", now: T0 });
    const both = `${byNew},${byOld.split(",")[1]}`;
    const options = { secret: ["new", "old"], now: T0, nonces };
    expect(await verifyEnvelope(BODY, both, options)).toMatchObject({
      ok: true,
      keyIndex: 0,
    });
    expect(await verifyEnvelope(BODY, byOld, options)).toMatchObject({
      ok: false,
      code: "REPLAYED",
    });
  });

  it("remembers only authentic, fresh requests", async () => {
    const calls: string[] = [];
    const spy: RemoteNonceStore = {
      remember: (nonce) => {
        calls.push(nonce);
        return true;
      },
    };
    const good = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    const forged = await signEnvelope(BODY, { secret: "x", now: T0 });
    await verifyEnvelope(BODY, forged, {
      secret: SECRET,
      now: T0,
      nonces: spy,
    });
    await verifyEnvelope(BODY, good, {
      secret: SECRET,
      now: T0 + 400_000,
      nonces: spy,
    });
    await verifyEnvelope(BODY, null, { secret: SECRET, now: T0, nonces: spy });
    expect(calls).toEqual([]);
    await verifyEnvelope(BODY, good, { secret: SECRET, now: T0, nonces: spy });
    expect(calls).toHaveLength(1);
  });

  it("holds each nonce until the window can no longer accept its timestamp", async () => {
    const seen: { expiresAt: number; now: number }[] = [];
    const spy: RemoteNonceStore = {
      remember: (_nonce, expiresAt, now) => {
        seen.push({ expiresAt, now });
        return true;
      },
    };
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    await verifyEnvelope(BODY, header, {
      secret: SECRET,
      now: T0 + 5,
      nonces: spy,
    });
    expect(seen).toEqual([
      { expiresAt: T0 + REMOTE_SIGNATURE_WINDOW_MS + 1, now: T0 + 5 },
    ]);
  });

  it("past the window, a replay is refused by the clock even once forgotten", async () => {
    const nonces = createRemoteNonceCache({ max: 1 });
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    expect(
      (await verifyEnvelope(BODY, header, { secret: SECRET, now: T0, nonces }))
        .ok,
    ).toBe(true);
    // Another request pushes the first out of a one-entry cache...
    const other = BODY.replace("p1", "p9");
    const later = T0 + REMOTE_SIGNATURE_WINDOW_MS + 1_000;
    await verifyEnvelope(
      other,
      await signEnvelope(other, { secret: SECRET, now: later }),
      { secret: SECRET, now: later, nonces },
    );
    // ...and the first, replayed now, fails on its timestamp.
    expect(
      await verifyEnvelope(BODY, header, {
        secret: SECRET,
        now: later,
        nonces,
      }),
    ).toMatchObject({ ok: false, code: "SIGNATURE_TIMESTAMP" });
  });

  it("takes an asynchronous store (a KV)", async () => {
    const kv = new Map<string, number>();
    const store: RemoteNonceStore = {
      remember: async (nonce, expiresAt) => {
        await Promise.resolve();
        if (kv.has(nonce)) return false;
        kv.set(nonce, expiresAt);
        return true;
      },
    };
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    const options = { secret: SECRET, now: T0, nonces: store };
    expect((await verifyEnvelope(BODY, header, options)).ok).toBe(true);
    expect((await verifyEnvelope(BODY, header, options)).ok).toBe(false);
  });

  describe("createRemoteNonceCache", () => {
    it("answers false for a nonce it holds, until it expires", () => {
      const cache = createRemoteNonceCache();
      expect(cache.remember("a", 100, 0)).toBe(true);
      expect(cache.remember("a", 100, 99)).toBe(false);
      expect(cache.remember("a", 200, 100)).toBe(true);
      expect(cache.remember("a", 200, 150)).toBe(false);
    });

    it("forgets the oldest past max, and only then", () => {
      const cache = createRemoteNonceCache({ max: 2 });
      cache.remember("a", 1_000, 0);
      cache.remember("b", 1_000, 0);
      expect(cache.remember("a", 1_000, 0)).toBe(false);
      cache.remember("c", 1_000, 0);
      expect(cache.remember("b", 1_000, 0)).toBe(false);
      // "a" went to make room for "c".
      expect(cache.remember("a", 1_000, 0)).toBe(true);
    });

    it("drops expired nonces from the front as it goes", () => {
      const cache = createRemoteNonceCache({ max: 2 });
      cache.remember("a", 10, 0);
      cache.remember("b", 1_000, 0);
      // "a" has expired, so "c" takes its place and "b" stays.
      cache.remember("c", 1_000, 20);
      expect(cache.remember("b", 1_000, 20)).toBe(false);
      expect(cache.remember("c", 1_000, 20)).toBe(false);
    });

    it("refuses an unusable max", () => {
      for (const max of [0, -1, 1.5, Number.NaN]) {
        expect(() => createRemoteNonceCache({ max })).toThrow(ConfigError);
      }
    });
  });
});

describe("key rotation", () => {
  it("signs with the first key of a list", async () => {
    const header = await signEnvelope(BODY, {
      secret: ["new", "old"],
      now: T0,
    });
    expect(header).toBe(await signEnvelope(BODY, { secret: "new", now: T0 }));
  });

  it("accepts the old key while it is listed, saying which key matched, then refuses it", async () => {
    const byOld = await signEnvelope(BODY, { secret: "old", now: T0 });
    const byNew = await signEnvelope(BODY, { secret: "new", now: T0 });

    // During the rotation: both listed, the new one first.
    const during = { secret: ["new", "old"], now: T0 };
    expect(await verifyEnvelope(BODY, byOld, during)).toMatchObject({
      ok: true,
      keyIndex: 1,
    });
    expect(await verifyEnvelope(BODY, byNew, during)).toMatchObject({
      ok: true,
      keyIndex: 0,
    });

    // After it: the old key removed.
    const after = { secret: ["new"], now: T0 };
    expect(await verifyEnvelope(BODY, byOld, after)).toMatchObject({
      ok: false,
      code: "SIGNATURE_INVALID",
    });
    expect((await verifyEnvelope(BODY, byNew, after)).ok).toBe(true);
  });

  it("a verifier still on the old key alone refuses the new one (the control)", async () => {
    const byNew = await signEnvelope(BODY, { secret: "new", now: T0 });
    expect(
      await verifyEnvelope(BODY, byNew, { secret: "old", now: T0 }),
    ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("refuses an unusable secret or clock", async () => {
    const header = await signEnvelope(BODY, { secret: SECRET, now: T0 });
    for (const secret of ["", [], ["ok", ""], [42 as unknown as string]]) {
      await expect(signEnvelope(BODY, { secret, now: T0 })).rejects.toThrow(
        ConfigError,
      );
      await expect(
        verifyEnvelope(BODY, header, { secret, now: T0 }),
      ).rejects.toThrow(ConfigError);
    }
    await expect(
      signEnvelope(BODY, { secret: SECRET, now: Number.NaN }),
    ).rejects.toThrow(ConfigError);
  });
});

describe("the MAC seam", () => {
  it("routes every MAC through the function it is given", async () => {
    let calls = 0;
    const counting: HmacSha256 = (key, message) => {
      calls++;
      return nodeHmacSha256(key, message);
    };
    const header = await signEnvelopeWith(counting, BODY, {
      secret: SECRET,
      now: T0,
    });
    await verifyEnvelopeWith(counting, BODY, header, {
      secret: ["other", SECRET],
      now: T0,
    });
    // One to sign; one per key tried to verify.
    expect(calls).toBe(3);
  });
});

describe('bodyless requests: `t "." id`', () => {
  const ID = "hs_01JB7Q2M9S0P";

  it("round-trips a GET, the id carried by the header", async () => {
    const header = await signEnvelope(null, {
      secret: SECRET,
      now: T0,
      id: ID,
    });
    expect(
      await verifyEnvelope(null, header, { secret: SECRET, now: T0, id: ID }),
    ).toEqual({ ok: true, timestamp: 1_790_000_000, keyIndex: 0 });
  });

  it("refuses a GET's replay", async () => {
    const nonces = createRemoteNonceCache();
    const header = await signEnvelope(null, {
      secret: SECRET,
      now: T0,
      id: ID,
    });
    const options = { secret: SECRET, now: T0 + 1_000, id: ID, nonces };
    expect((await verifyEnvelope(null, header, options)).ok).toBe(true);
    expect(await verifyEnvelope(null, header, options)).toMatchObject({
      ok: false,
      code: "REPLAYED",
      status: 401,
    });
  });

  it("passes two GETs signed in the same second with different ids", async () => {
    const nonces = createRemoteNonceCache();
    for (const id of ["hs_a", "hs_b"]) {
      const header = await signEnvelope(null, { secret: SECRET, now: T0, id });
      expect(
        await verifyEnvelope(null, header, {
          secret: SECRET,
          now: T0,
          id,
          nonces,
        }),
      ).toMatchObject({ ok: true });
    }
  });

  it("refuses a changed id: the id is under the MAC", async () => {
    const header = await signEnvelope(null, {
      secret: SECRET,
      now: T0,
      id: ID,
    });
    for (const id of ["hs_01JB7Q2M9S0Q", `${ID}x`, ID.slice(1)]) {
      expect(
        await verifyEnvelope(null, header, { secret: SECRET, now: T0, id }),
      ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
    }
  });

  it("is SIGNATURE_MISSING without an id, or with one outside the grammar", async () => {
    const header = await signEnvelope(null, {
      secret: SECRET,
      now: T0,
      id: ID,
    });
    for (const id of [
      undefined,
      null,
      "",
      "has space",
      "{}",
      "x".repeat(201),
    ]) {
      expect(
        await verifyEnvelope(null, header, { secret: SECRET, now: T0, id }),
      ).toMatchObject({ ok: false, code: "SIGNATURE_MISSING", status: 401 });
    }
  });

  it("will not sign a bodyless request without a usable id", async () => {
    for (const id of [undefined, "", "a b"]) {
      await expect(
        signEnvelope(null, { secret: SECRET, now: T0, id }),
      ).rejects.toThrow(ConfigError);
    }
  });

  it("an empty-body POST and a GET with the same t do not verify each other", async () => {
    const get = await signEnvelope(null, { secret: SECRET, now: T0, id: ID });
    const post = await signEnvelope("", { secret: SECRET, now: T0 });
    expect(get).not.toBe(post);
    expect(
      await verifyEnvelope("", get, { secret: SECRET, now: T0 }),
    ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
    expect(
      await verifyEnvelope(null, post, { secret: SECRET, now: T0, id: ID }),
    ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("a GET's signature replayed as a POST whose body is the id is refused", async () => {
    // `t "." id` and `t "." raw` are the same bytes when raw is the id: a
    // body that is a bare id token is refused, so the two forms never meet.
    const get = await signEnvelope(null, { secret: SECRET, now: T0, id: ID });
    expect(
      await verifyEnvelope(ID, get, { secret: SECRET, now: T0 }),
    ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
    await expect(signEnvelope(ID, { secret: SECRET, now: T0 })).rejects.toThrow(
      ConfigError,
    );
  });

  it("an id passed with a body is not part of the payload", async () => {
    const header = await signEnvelope(BODY, {
      secret: SECRET,
      now: T0,
      id: "x",
    });
    expect(header).toBe(await signEnvelope(BODY, { secret: SECRET, now: T0 }));
  });

  it("the window applies to a GET too", async () => {
    const header = await signEnvelope(null, {
      secret: SECRET,
      now: T0,
      id: ID,
    });
    expect(
      await verifyEnvelope(null, header, {
        secret: SECRET,
        now: T0 - REMOTE_SIGNATURE_WINDOW_MS - 1,
        id: ID,
      }),
    ).toMatchObject({ ok: false, code: "SIGNATURE_TIMESTAMP" });
  });
});
