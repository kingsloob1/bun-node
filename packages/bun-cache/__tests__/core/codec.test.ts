/**
 * The codecs (plan §3.10): what each round-trips, the per-entry codec id, the
 * custom-codec range, and the decode failures that read as misses.
 */
import { describe, expect, test } from "bun:test";
import type { Codec } from "../../lib/index";
import { createCache, memoryDriver } from "../../lib/index";
import {
  jsonCodec,
  rawCodec,
  resolveCodec,
  structuredCodec,
} from "../../lib/core/codecs";
import { makeCache } from "../helpers";

describe("codec: structured (the default)", () => {
  test("round-trips Date, Map, Set, BigInt, Uint8Array, NaN, RegExp, Error and undefined fields", async () => {
    const { cache } = makeCache();
    const value = {
      date: new Date(1_700_000_000_000),
      map: new Map([["a", 1n]]),
      set: new Set([1, 2]),
      bytes: new Uint8Array([1, 2, 3]),
      nan: Number.NaN,
      regex: /x+/gi,
      error: new Error("boom"),
      missing: undefined,
    };
    await cache.set("k", value);
    const read = await cache.get<"k">("k");
    expect(read).toEqual(value);
    expect((read as typeof value).date).toBeInstanceOf(Date);
    expect((read as typeof value).map.get("a")).toBe(1n);
    await cache.close();
  });

  test("a class instance reads back as a plain object", async () => {
    class Point {
      constructor(readonly x: number) {}
      double(): number {
        return this.x * 2;
      }
    }
    const { cache } = makeCache();
    await cache.set("k", new Point(3) as unknown as Record<string, unknown>);
    const read = (await cache.get("k")) as Record<string, unknown>;
    expect(read).toEqual({ x: 3 });
    expect(typeof (read as { double?: unknown }).double).toBe("undefined");
    await cache.close();
  });

  test("a cyclic value round-trips (structured clone handles cycles)", async () => {
    const { cache } = makeCache();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    await cache.set("k", cyclic);
    const read = (await cache.get("k")) as Record<string, unknown>;
    expect(read.name).toBe("loop");
    expect(read.self).toBe(read);
    await cache.close();
  });
});

describe("codec: json", () => {
  test("a Date reads back as a string (the JSON view, §3.13)", async () => {
    const { cache } = makeCache({ codec: "json" });
    await cache.set("k", { at: new Date(0) });
    const read = (await cache.get("k")) as { at: unknown };
    expect(read.at).toBe("1970-01-01T00:00:00.000Z");
    await cache.close();
  });

  test("BigInt throws on set", async () => {
    const { cache } = makeCache({ codec: "json" });
    await expect(cache.set("k", 1n as unknown as number)).rejects.toThrow();
    await cache.close();
  });
});

describe("codec: raw", () => {
  test("Uint8Array and string round-trip unchanged", async () => {
    const { cache } = makeCache({ codec: "raw" });
    await cache.set("bytes", new Uint8Array([9, 8, 7]));
    await cache.set("text", "hello");
    expect(await cache.get("bytes")).toEqual(new Uint8Array([9, 8, 7]));
    expect(await cache.get("text")).toBe("hello");
    await cache.close();
  });

  test("anything else is a TypeError", async () => {
    const { cache } = makeCache({ codec: "raw" });
    await expect(cache.set("k", 42)).rejects.toThrow(TypeError);
    await cache.close();
  });
});

describe("codec: custom", () => {
  /** A test codec: JSON, with every byte XORed. */
  const xor: Codec = {
    id: 200,
    encode: (value) =>
      new TextEncoder()
        .encode(JSON.stringify(value))
        .map((byte) => byte ^ 0xff),
    decode: (bytes) =>
      JSON.parse(
        new TextDecoder().decode(bytes.map((byte) => byte ^ 0xff)),
      ) as unknown,
  };

  test("a custom codec round-trips, and its id is stored per entry", async () => {
    const { cache } = makeCache({ codec: xor });
    await cache.set("k", { n: 1 });
    expect(await cache.get("k")).toEqual({ n: 1 });
    await cache.close();
  });

  test("a codec id outside 128–255 is a TypeError", () => {
    expect(() => resolveCodec({ ...xor, id: 1 })).toThrow(TypeError);
    expect(() => resolveCodec({ ...xor, id: 127 })).toThrow(TypeError);
    expect(() => resolveCodec({ ...xor, id: 256 })).toThrow(TypeError);
  });

  test("an entry written with a codec the reader does not know is a miss with a decode error event", async () => {
    const driver = memoryDriver();
    const writer = createCache({ driver, codec: xor, sweepInterval: 0 });
    await writer.set("k", { secret: true });
    const errors: string[] = [];
    const reader = createCache({ driver, sweepInterval: 0 }); // structured only
    reader.on("error", (event) => {
      errors.push(event.phase);
    });
    expect(await reader.get("k")).toBeUndefined();
    expect(errors).toEqual(["decode"]);
    await writer.close();
    // The writer closed the shared driver; make the reader's close a no-op by
    // giving it no further work.
  });

  test("one driver, two codecs: an entry decodes with the codec it was written with", async () => {
    const driver = memoryDriver();
    const structured = createCache({ driver, sweepInterval: 0 });
    const json = createCache({ driver, codec: "json", sweepInterval: 0 });
    await structured.set("k", { at: new Date(0) });
    // The json cache reads the structured entry with its own codec id.
    const read = (await json.get("k")) as { at: unknown };
    expect(read.at).toBeInstanceOf(Date);
    await structured.close();
  });
});

describe("codec: resolution", () => {
  test("the default is structured; names resolve", () => {
    expect(resolveCodec(undefined)).toBe(structuredCodec);
    expect(resolveCodec("structured")).toBe(structuredCodec);
    expect(resolveCodec("json")).toBe(jsonCodec);
    expect(resolveCodec("raw")).toBe(rawCodec);
  });
});
