import type { HmacSha256 } from "../../lib/remote/mac";
import type {
  DecodeTextFrameOptions,
  FrameMessage,
  FrameRole,
} from "../../lib/remote/protocol/frame";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "bun:test";
import { nodeHmacSha256 } from "../../lib/remote/host/mac";
import { subtleHmacSha256 } from "../../lib/remote/mac";
import { createRemoteNonceCache } from "../../lib/remote/nonce";
import {
  admitHello,
  createFrameNonce,
  decodeTextFrame,
  encodeTextFrame,
  FRAME_MAC_LENGTH,
  frameMacInput,
  HELLO_SID,
  macFromBase64Url,
  parseTextFrame,
  sessionId,
  toBase64Url,
} from "../../lib/remote/protocol/frame";
import { keysOf } from "../../lib/remote/signing";
import { ConfigError } from "../../lib/shared/errors";

/**
 * The text frame codec: `remote-transports.md` §4.3.1 (the line), §4.4.1
 * (the MAC and the handshake's). Every test runs through both MAC
 * implementations of the seam where the MAC matters.
 */

const SECRET = "frame-test-secret";
const [KEY] = keysOf(SECRET);
const NONCE_G = "q3JtZ2FfZ3c0bE1uUXpXRA";
const NONCE_E = "Ym9iX2V4ZWN1dG9yX25vbg";
const SID = sessionId(NONCE_G, NONCE_E);
const T0 = 1_790_000_000_000;

const MACS: { name: string; fn: HmacSha256 }[] = [
  { name: "crypto.subtle", fn: subtleHmacSha256 },
  { name: "node:crypto", fn: nodeHmacSha256 },
];

const ACCEPTED: FrameMessage = {
  op: "accepted",
  job: "01JB7Q2M8ZRT9V",
  attempt: 1,
  fence: "h7f3:1",
  duplicate: false,
  at: 1790000000470,
};

/** Encodes `message` as the executor's frame `seq`/`ack` in the test session. */
function encode(
  message: FrameMessage,
  over: Partial<{
    sid: string;
    dir: FrameRole;
    seq: number;
    ack: number;
    key: Uint8Array;
    mac: HmacSha256;
  }> = {},
): Promise<string> {
  return encodeTextFrame(message, {
    key: KEY!,
    sid: SID,
    dir: "e",
    seq: 1,
    ack: 0,
    ...over,
  });
}

/** Decodes as the gateway would, for the executor's frames in the test session. */
function decode(line: string, over: Partial<DecodeTextFrameOptions> = {}) {
  return decodeTextFrame(line, { keys: [KEY!], sid: SID, dir: "e", ...over });
}

/**
 * An executor's frame with a valid MAC over any JSON text, `ack` 0: it
 * bypasses the encoder's own checks, to test the decoder's.
 */
function rawFrame(json: string, seq: number, sid: string): string {
  const input = frameMacInput(sid, "e", String(seq), "0", json);
  const mac = toBase64Url(nodeHmacSha256(KEY!, input) as Uint8Array);
  return `BJ1 ${seq} 0 ${mac} ${json}`;
}

/** The line's fields, split on the first four spaces. */
function fields(line: string): [string, string, string, string, string] {
  const at: number[] = [];
  let from = 0;
  for (let i = 0; i < 4; i++) {
    from = line.indexOf(" ", from) + 1;
    at.push(from);
  }
  return [
    line.slice(0, at[0]! - 1),
    line.slice(at[0], at[1]! - 1),
    line.slice(at[1], at[2]! - 1),
    line.slice(at[2], at[3]! - 1),
    line.slice(at[3]),
  ];
}

/** The line with one field replaced and nothing re-MAC'd. */
function replace(line: string, index: number, value: string): string {
  const parts = fields(line);
  parts[index] = value;
  return parts.join(" ");
}

describe("round trips", () => {
  for (const mac of MACS) {
    it(`${mac.name}: a sequenced frame decodes to what was encoded`, async () => {
      const line = await encode(ACCEPTED, { seq: 7, ack: 3, mac: mac.fn });
      expect(line.startsWith("BJ1 7 3 ")).toBe(true);
      const result = await decode(line, { mac: mac.fn });
      expect(result).toEqual({
        ok: true,
        frame: {
          seq: 7,
          ack: 3,
          message: ACCEPTED,
          json: JSON.stringify(ACCEPTED),
          keyIndex: 0,
        },
      });
    });
  }

  it("the two MACs produce the same line, and each verifies the other's", async () => {
    const subtle = await encode(ACCEPTED, { mac: subtleHmacSha256 });
    const node = await encode(ACCEPTED, { mac: nodeHmacSha256 });
    expect(node).toBe(subtle);
    expect((await decode(subtle, { mac: nodeHmacSha256 })).ok).toBe(true);
    expect((await decode(node, { mac: subtleHmacSha256 })).ok).toBe(true);
  });

  it("keeps the JSON byte for byte, spaces and all, which split(' ', 4) would cut", async () => {
    const message = { op: "log", message: "a b  c   d", at: 1 };
    const line = await encode(message);
    expect(line.split(" ", 5)[4]).not.toBe(JSON.stringify(message));
    const result = await decode(line);
    expect(result.ok && result.frame.json).toBe(JSON.stringify(message));
    expect(result.ok && result.frame.message).toEqual(message);
  });

  it("carries text outside ASCII, MAC'd as UTF-8", async () => {
    const message = { op: "log", message: "café ☕ 𝄞", at: 1 };
    const result = await decode(await encode(message));
    expect(result.ok && result.frame.message).toEqual(message);
  });

  it("escapes a line break inside a string, so the frame stays one line", async () => {
    const message = { op: "log", message: "one\ntwo\r\nthree", at: 1 };
    const line = await encode(message);
    expect(line).not.toMatch(/[\r\n]/);
    const result = await decode(line);
    expect(result.ok && result.frame.message).toEqual(message);
  });

  it("the handshake: hello under -, welcome under the hello's nonce, ack in the session", async () => {
    const hello = { op: "hello", v: 1, nonce: NONCE_G, t: 1790000000 };
    const welcome = { op: "welcome", v: 1, nonce: NONCE_E };
    const helloLine = await encode(hello, {
      sid: HELLO_SID,
      dir: "g",
      seq: 0,
    });
    const welcomeLine = await encode(welcome, { sid: NONCE_G, seq: 0 });
    const ackLine = await encode({ op: "ack" }, { dir: "g", seq: 0, ack: 4 });
    expect((await decode(helloLine, { sid: HELLO_SID, dir: "g" })).ok).toBe(
      true,
    );
    expect((await decode(welcomeLine, { sid: NONCE_G })).ok).toBe(true);
    const ack = await decode(ackLine, { dir: "g" });
    expect(ack.ok && [ack.frame.seq, ack.frame.ack]).toEqual([0, 4]);
  });

  it("an http-stream frame: the invoke id is the sid", async () => {
    const line = await encode(ACCEPTED, { sid: "inv_01JB7Q2M9S0P" });
    expect((await decode(line, { sid: "inv_01JB7Q2M9S0P" })).ok).toBe(true);
    expect((await decode(line)).ok).toBe(false);
  });

  it("the largest counters round-trip in decimal", async () => {
    const max = Number.MAX_SAFE_INTEGER;
    const line = await encode(ACCEPTED, { seq: max, ack: max });
    expect(line.startsWith(`BJ1 ${max} ${max} `)).toBe(true);
    const result = await decode(line);
    expect(result.ok && [result.frame.seq, result.frame.ack]).toEqual([
      max,
      max,
    ]);
  });

  it("verifies under a rotated key and says which", async () => {
    const [oldKey, newKey] = keysOf(["old-frame-key", "new-frame-key"]);
    const line = await encode(ACCEPTED, { key: newKey });
    const result = await decode(line, { keys: [oldKey!, newKey!] });
    expect(result.ok && result.frame.keyIndex).toBe(1);
    expect((await decode(line, { keys: [oldKey!] })).ok).toBe(false);
  });
});

describe("the MAC binds every field", () => {
  for (const mac of MACS) {
    describe(mac.name, () => {
      const refusedForMac = async (
        line: string,
        over: Partial<DecodeTextFrameOptions> = {},
      ) =>
        expect(await decode(line, { mac: mac.fn, ...over })).toMatchObject({
          ok: false,
          reason: "mac",
        });

      it("sid: a frame from one session does not verify in another", async () => {
        const line = await encode(ACCEPTED, { mac: mac.fn });
        await refusedForMac(line, { sid: sessionId(NONCE_G, NONCE_G) });
        await refusedForMac(line, { sid: "inv_01JB7Q2M9S0P" });
      });

      it("dir: a frame cannot be reflected at its sender", async () => {
        const line = await encode(ACCEPTED, { mac: mac.fn, dir: "e" });
        await refusedForMac(line, { dir: "g" });
        const fromGateway = await encode(
          { op: "ping", id: "p1" },
          { mac: mac.fn, dir: "g" },
        );
        await refusedForMac(fromGateway, { dir: "e" });
      });

      it("seq: renumbering a frame breaks it", async () => {
        const line = await encode(ACCEPTED, { mac: mac.fn, seq: 5 });
        await refusedForMac(replace(line, 1, "6"));
        await refusedForMac(replace(line, 1, "4"));
      });

      it("ack: forging an acknowledgement breaks it", async () => {
        const line = await encode(ACCEPTED, { mac: mac.fn, ack: 2 });
        await refusedForMac(replace(line, 2, "9"));
        await refusedForMac(replace(line, 2, "0"));
      });

      it("payload: one changed byte of the JSON breaks it", async () => {
        const line = await encode(ACCEPTED, { mac: mac.fn });
        await refusedForMac(line.replace('"attempt":1', '"attempt":2'));
        await refusedForMac(
          line.replace('"duplicate":false', '"duplicate":true'),
        );
        // Whitespace the JSON parser would not care about.
        await refusedForMac(`${line} `);
      });

      it("mac: one changed character of the MAC breaks it", async () => {
        const line = await encode(ACCEPTED, { mac: mac.fn });
        const sent = fields(line)[3];
        const other = sent[5] === "A" ? "B" : "A";
        await refusedForMac(
          replace(line, 3, sent.slice(0, 5) + other + sent.slice(6)),
        );
      });

      it("key: another secret's frame does not verify", async () => {
        const [other] = keysOf("another-secret");
        const line = await encode(ACCEPTED, { mac: mac.fn, key: other });
        await refusedForMac(line);
      });

      it("the untampered frame verifies (the control)", async () => {
        const line = await encode(ACCEPTED, { mac: mac.fn, seq: 5, ack: 2 });
        expect((await decode(line, { mac: mac.fn })).ok).toBe(true);
      });
    });
  }
});

describe("malformed frames are refused before the MAC is computed", () => {
  /** A MAC that fails the test if it is ever called. */
  const never: HmacSha256 = () => {
    throw new Error("the MAC was computed for a malformed frame");
  };
  let good = "";

  const malformed = async (line: string, detail?: RegExp) => {
    if (good === "") {
      good = await encode(ACCEPTED, { seq: 12, ack: 3 });
    }
    const result = await decode(line, { mac: never });
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
    if (detail && !result.ok) {
      expect(result.detail).toMatch(detail);
    }
  };

  it("the control: the well-formed line reaches the MAC", async () => {
    good = await encode(ACCEPTED, { seq: 12, ack: 3 });
    await expect(decode(good, { mac: never })).rejects.toThrow(
      "the MAC was computed",
    );
  });

  it("magic", async () => {
    const line = await encode(ACCEPTED);
    await malformed(replace(line, 0, "BJ2"), /starts/);
    await malformed(replace(line, 0, "bj1"), /starts/);
    await malformed(replace(line, 0, "BJ10"), /starts/);
    await malformed(` ${line}`, /starts/);
    await malformed(line.slice(3), /starts/);
    await malformed("", /starts/);
  });

  it("the number of fields", async () => {
    const line = await encode(ACCEPTED);
    const [, seq, ack, mac] = fields(line);
    await malformed(`BJ1 ${seq} ${ack} ${mac}`, /five fields/);
    await malformed(`BJ1 ${seq} ${ack}`, /five fields/);
    await malformed(`BJ1 ${seq} ${ack} ${mac} `, /no message/);
    // A doubled separator shifts every field after it.
    await malformed(line.replace("BJ1 ", "BJ1  "), /seq/);
  });

  it("seq", async () => {
    const line = await encode(ACCEPTED, { seq: 12 });
    for (const bad of [
      "",
      "012",
      "-1",
      "+1",
      "1.0",
      "1e3",
      "0x1",
      " 1",
      "１２",
    ]) {
      await malformed(replace(line, 1, bad));
    }
    // 2^53 is past the safe range, and 17 digits past the grammar.
    await malformed(replace(line, 1, "9007199254740992"), /seq/);
    await malformed(replace(line, 1, "10000000000000000"), /seq/);
  });

  it("ack", async () => {
    const line = await encode(ACCEPTED, { ack: 3 });
    for (const bad of ["", "03", "-0", "3.5", "9007199254740992"]) {
      await malformed(replace(line, 2, bad), /ack/);
    }
  });

  it("mac", async () => {
    const line = await encode(ACCEPTED);
    const mac = fields(line)[3];
    await malformed(replace(line, 3, mac.slice(1)), /mac/);
    await malformed(replace(line, 3, `${mac}A`), /mac/);
    await malformed(replace(line, 3, `${mac}=`), /mac/);
    await malformed(replace(line, 3, `${mac.slice(0, 42)}+`), /mac/);
    await malformed(replace(line, 3, `${mac.slice(0, 42)}/`), /mac/);
    await malformed(replace(line, 3, `${mac.slice(0, 42)}é`), /mac/);
    // Hex is not base64url's length.
    await malformed(replace(line, 3, "ab".repeat(32)), /mac/);
  });

  it("the MAC's unused low bits must be zero: one spelling per MAC", async () => {
    const line = await encode(ACCEPTED);
    const mac = fields(line)[3];
    const last = mac[42]!;
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const value = alphabet.indexOf(last);
    expect(value & 3).toBe(0);
    for (const low of [1, 2, 3]) {
      await malformed(
        replace(line, 3, mac.slice(0, 42) + alphabet[value | low]),
        /mac/,
      );
    }
  });

  it("json: absent, or broken across lines", async () => {
    const line = await encode(ACCEPTED);
    await malformed(`${line}\n`, /one line/);
    await malformed(`${line}\r`, /one line/);
    await malformed(line.replace('"job"', '"j\nob"'), /one line/);
    await malformed(line.replace('"job"', '"j\rob"'), /one line/);
  });

  it("not a string at all", async () => {
    expect(parseTextFrame(42 as unknown as string)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("an authentic frame whose message is not one", () => {
  /** A line with a valid MAC over arbitrary JSON text. */
  function forged(json: string): string {
    return rawFrame(json, 1, SID);
  }

  it("refuses JSON that does not parse, an array, null, and an object without a string op", async () => {
    for (const json of [
      "{",
      "not json",
      "[]",
      "null",
      "42",
      '"accepted"',
      "{}",
      '{"op":1}',
      '{"op":null}',
    ]) {
      expect(await decode(forged(json))).toMatchObject({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("accepts the same construction with a real message (the control)", async () => {
    expect((await decode(forged('{"op":"ping"}'))).ok).toBe(true);
  });
});

describe("the frame's context: seq and sid must fit the op", () => {
  it("seq 0 is for hello, welcome and ack only, and they are always 0", async () => {
    const raw = (json: string, seq: number, sid = SID) =>
      rawFrame(json, seq, sid);

    expect(await decode(raw('{"op":"accepted"}', 0))).toMatchObject({
      ok: false,
      reason: "context",
    });
    expect(await decode(raw('{"op":"ack"}', 3))).toMatchObject({
      ok: false,
      reason: "context",
    });
    expect(
      await decode(raw('{"op":"welcome"}', 1, NONCE_G), { sid: NONCE_G }),
    ).toMatchObject({ ok: false, reason: "context" });
    expect((await decode(raw('{"op":"ack"}', 0))).ok).toBe(true);
  });

  it("only a hello is MAC'd under -, and a hello under nothing else", async () => {
    const raw = (json: string, sid: string) => rawFrame(json, 0, sid);
    expect(
      await decode(raw('{"op":"ack"}', HELLO_SID), { sid: HELLO_SID }),
    ).toMatchObject({ ok: false, reason: "context" });
    expect(await decode(raw('{"op":"hello"}', SID))).toMatchObject({
      ok: false,
      reason: "context",
    });
    // A welcome's sid is a nonce, never a session or an invoke id.
    expect(await decode(raw('{"op":"welcome"}', SID))).toMatchObject({
      ok: false,
      reason: "context",
    });
    expect(
      (await decode(raw('{"op":"hello"}', HELLO_SID), { sid: HELLO_SID })).ok,
    ).toBe(true);
  });

  it("the encoder refuses the same mistakes", async () => {
    await expect(encode(ACCEPTED, { seq: 0 })).rejects.toThrow(ConfigError);
    await expect(encode({ op: "ack" }, { seq: 1 })).rejects.toThrow(
      ConfigError,
    );
    await expect(encode({ op: "hello" }, { seq: 0, sid: SID })).rejects.toThrow(
      ConfigError,
    );
    await expect(encode({ op: "ping" }, { sid: HELLO_SID })).rejects.toThrow(
      ConfigError,
    );
    await expect(
      encode({ op: "welcome" }, { seq: 0, sid: SID }),
    ).rejects.toThrow(ConfigError);
  });
});

describe("the encoder's other checks", () => {
  it("refuses an unusable sid, role, counter, key or message", async () => {
    const cases: Parameters<typeof encode>[1][] = [
      { sid: "" },
      { sid: "a\nb" },
      { sid: "has space" },
      { dir: "x" as FrameRole },
      { seq: -1 },
      { seq: 1.5 },
      { seq: Number.MAX_SAFE_INTEGER + 1 },
      { ack: -1 },
      { ack: Number.NaN },
      { key: new Uint8Array(0) },
    ];
    for (const over of cases) {
      await expect(encode(ACCEPTED, over)).rejects.toThrow(ConfigError);
    }
    for (const message of [
      null,
      [],
      "accepted",
      {},
      { op: 1 },
    ] as unknown as FrameMessage[]) {
      await expect(encode(message)).rejects.toThrow(ConfigError);
    }
  });

  it("refuses a message a toJSON turns into something other than an object", async () => {
    for (const toJSON of [() => "x", () => [1], () => undefined, () => null]) {
      await expect(encode({ op: "log", toJSON })).rejects.toThrow(ConfigError);
    }
    // A toJSON that keeps it an object is the message sent (the control).
    const line = await encode({
      op: "log",
      toJSON: () => ({ op: "log", n: 1 }),
    });
    const result = await decode(line);
    expect(result.ok && result.frame.message).toEqual({ op: "log", n: 1 });
  });
});

describe("decoder options", () => {
  it("throws for an unusable sid, role or key list", async () => {
    const line = await encode(ACCEPTED);
    await expect(decode(line, { sid: "" })).rejects.toThrow(ConfigError);
    await expect(decode(line, { dir: "x" as FrameRole })).rejects.toThrow(
      ConfigError,
    );
    await expect(decode(line, { keys: [] })).rejects.toThrow(ConfigError);
  });
});

describe("the size limit", () => {
  it("refuses a line over maxBytes before anything else, counting UTF-8 bytes", async () => {
    const never: HmacSha256 = () => {
      throw new Error("the MAC was computed for an oversize frame");
    };
    const line = await encode({ op: "log", message: "é".repeat(100) });
    const bytes = new TextEncoder().encode(line).length;
    expect(bytes).toBeGreaterThan(line.length);
    expect(
      await decode(line, { maxBytes: bytes - 1, mac: never }),
    ).toMatchObject({ ok: false, reason: "too-large" });
    // Under the byte count but over the character count would pass a
    // character-counting check: this one counts bytes.
    expect(
      await decode(line, { maxBytes: line.length + 1, mac: never }),
    ).toMatchObject({ ok: false, reason: "too-large" });
    expect((await decode(line, { maxBytes: bytes })).ok).toBe(true);
    // Not even a frame, but too large: the size is checked first.
    expect(parseTextFrame("x".repeat(100), 99)).toMatchObject({
      reason: "too-large",
    });
  });

  it("counts a character outside the BMP as four bytes", () => {
    const line = `BJ1 1 0 ${"A".repeat(43)} {"m":"${"𝄞".repeat(10)}"}`;
    const bytes = new TextEncoder().encode(line).length;
    expect(parseTextFrame(line, bytes - 1)).toMatchObject({
      reason: "too-large",
    });
    expect(parseTextFrame(line, bytes).ok).toBe(true);
  });

  it("counts a character in the BMP's upper range as three bytes", () => {
    // Mostly three-byte characters, so twice the length is under the bytes.
    const line = `BJ1 1 0 ${"A".repeat(43)} {"m":"${"☕".repeat(200)}"}`;
    const bytes = new TextEncoder().encode(line).length;
    expect(line.length * 2).toBeLessThan(bytes);
    expect(parseTextFrame(line, bytes - 1)).toMatchObject({
      reason: "too-large",
    });
    expect(parseTextFrame(line, line.length * 2)).toMatchObject({
      reason: "too-large",
    });
    expect(parseTextFrame(line, bytes).ok).toBe(true);
  });
});

describe("base64url and nonces", () => {
  it("encodes like the platform's base64url, unpadded, at every length", () => {
    for (let length = 0; length < 40; length++) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });

  it("decodes a MAC back to its bytes", () => {
    for (let i = 0; i < 50; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const text = toBase64Url(bytes);
      expect(text).toHaveLength(FRAME_MAC_LENGTH);
      expect(macFromBase64Url(text)).toEqual(bytes);
    }
  });

  it("createFrameNonce gives 128 fresh bits as 22 characters", () => {
    const nonces = new Set(Array.from({ length: 100 }, createFrameNonce));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[\w-]{22}$/);
    }
  });

  it("sessionId joins two nonces with a dot, and refuses anything else", () => {
    expect(sessionId(NONCE_G, NONCE_E)).toBe(`${NONCE_G}.${NONCE_E}`);
    expect(() => sessionId("short", NONCE_E)).toThrow(ConfigError);
    expect(() => sessionId(NONCE_G, `${NONCE_E}.`)).toThrow(ConfigError);
  });
});

describe("admitHello: the handshake's replay window and nonce cache", () => {
  const hello = (over: Record<string, unknown> = {}): FrameMessage => ({
    op: "hello",
    nonce: createFrameNonce(),
    t: T0 / 1000,
    ...over,
  });

  it("admits a fresh hello once, and refuses its nonce again", async () => {
    const nonces = createRemoteNonceCache();
    const first = hello();
    expect(await admitHello(first, { now: T0, nonces })).toEqual({ ok: true });
    expect(await admitHello(first, { now: T0 + 1000, nonces })).toMatchObject({
      ok: false,
      code: "REPLAYED",
    });
    // The nonce is what is remembered, so changing the rest does not help.
    expect(
      await admitHello(
        { ...first, t: T0 / 1000 + 1 },
        { now: T0 + 1000, nonces },
      ),
    ).toMatchObject({ ok: false, code: "REPLAYED" });
  });

  it("applies the window in both directions, to the second", async () => {
    const nonces = createRemoteNonceCache();
    const at = (seconds: number) =>
      admitHello(hello({ t: T0 / 1000 + seconds }), { now: T0, nonces });
    expect(await at(-300)).toEqual({ ok: true });
    expect(await at(300)).toEqual({ ok: true });
    expect(await at(-301)).toMatchObject({ code: "SIGNATURE_TIMESTAMP" });
    expect(await at(301)).toMatchObject({ code: "SIGNATURE_TIMESTAMP" });
  });

  it("checks the window before the nonce, so a stale hello does not burn its nonce", async () => {
    const nonces = createRemoteNonceCache();
    const stale = hello({ t: T0 / 1000 - 1000 });
    expect(await admitHello(stale, { now: T0, nonces })).toMatchObject({
      code: "SIGNATURE_TIMESTAMP",
    });
    expect(await admitHello(stale, { now: T0 - 1_000_000, nonces })).toEqual({
      ok: true,
    });
  });

  it("forgets a nonce once its window has passed", async () => {
    const nonces = createRemoteNonceCache();
    const first = hello();
    expect(await admitHello(first, { now: T0, nonces })).toEqual({ ok: true });
    // Past the window the timestamp refuses it anyway; the cache is free to forget.
    expect(
      await admitHello(first, { now: T0 + 300_001, nonces }),
    ).toMatchObject({ code: "SIGNATURE_TIMESTAMP" });
  });

  it("a narrower window narrows; a wider one is refused", async () => {
    const nonces = createRemoteNonceCache();
    expect(
      await admitHello(hello({ t: T0 / 1000 - 20 }), {
        now: T0,
        nonces,
        windowMs: 10_000,
      }),
    ).toMatchObject({ code: "SIGNATURE_TIMESTAMP" });
    await expect(
      admitHello(hello(), { now: T0, nonces, windowMs: 300_001 }),
    ).rejects.toThrow(ConfigError);
    await expect(
      admitHello(hello(), {
        now: T0,
        nonces: undefined as unknown as ReturnType<
          typeof createRemoteNonceCache
        >,
      }),
    ).rejects.toThrow(ConfigError);
  });

  it("refuses a hello without a usable t or nonce, and anything not a hello", async () => {
    const nonces = createRemoteNonceCache();
    for (const bad of [
      hello({ t: "1790000000" }),
      hello({ t: -1 }),
      hello({ t: 1.5 }),
      hello({ nonce: "short" }),
      hello({ nonce: undefined }),
      hello({ op: "welcome" }),
    ]) {
      expect(await admitHello(bad, { now: T0, nonces })).toMatchObject({
        ok: false,
        code: "malformed",
      });
    }
  });
});
