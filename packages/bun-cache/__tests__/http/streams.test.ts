/**
 * Streamed responses under `streams: { buffer }` (plan §9.4): the body is
 * copied as it is sent, the first byte is not held back, the client's reads
 * drive the source and its cancel reaches it, and the copy is stored only
 * when the stream ends within the buffer. `text/event-stream` never is.
 */
import { describe, expect, test } from "bun:test";
import type { BunResponse } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRouter,
  createDeferred,
} from "@kingsleyweb/bun-common";
import type { Cache, CacheDriver } from "../../lib/index";
import { createCache, memoryDriver } from "../../lib/index";
import type { CacheResponseOptions } from "../../lib/http/index";
import { cacheResponse } from "../../lib/http/index";
import { tapStream } from "../../lib/http/capture";
import { frameAt, keyFor, makeHttpCache, nextSet } from "./helpers";

const encoder = new TextEncoder();

/**
 * A cache whose driver takes `lagMs` over every write (reads are not
 * delayed), as a networked driver does: a write still running when the
 * client sees a stream's end is then visible to a read right after.
 */
function slowWriteCache(lagMs: number): Cache {
  const inner = memoryDriver();
  const driver = new Proxy(inner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === "set" && typeof value === "function") {
        return async (...args: Parameters<CacheDriver["set"]>) => {
          await Bun.sleep(lagMs);
          return await inner.set(...args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return createCache({ driver, sweepInterval: 0 });
}
const decoder = new TextDecoder();

/** What the tests read a body with. */
interface ChunkReader {
  /** The next chunk, or the end. */
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
}

/** Reads a body's first chunk, as text. */
async function firstChunk(reader: ChunkReader): Promise<string> {
  const { value } = await reader.read();
  return decoder.decode(value);
}

/** Reads the rest of a stream, as text. */
async function rest(reader: ChunkReader): Promise<string> {
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text;
    }
    text += decoder.decode(value);
  }
}

/**
 * A `/s` route that writes `first`, waits for the test to open the gate,
 * then writes `second` and ends — so a first byte held back until the
 * stream's end would never arrive (the test would time out).
 */
function gatedStream(
  options: CacheResponseOptions,
  first = "one ",
  second = "two",
  cache: Cache = makeHttpCache(),
) {
  let gate = createDeferred<void>();
  let runs = 0;
  const handler = async (_req: unknown, res: BunResponse) => {
    runs++;
    res.setHeader("Cache-Control", "max-age=60");
    res.type("text/plain");
    res.write(first);
    await gate.promise;
    res.write(second);
    await res.end();
  };
  return {
    cache,
    handler,
    pages: cacheResponse(cache, options),
    runs: () => runs,
    open: () => {
      gate.resolve();
    },
    reset: () => {
      gate = createDeferred<void>();
    },
  };
}

describe("streams: { buffer } (§9.4)", () => {
  test("over a real socket: the first chunk arrives before the stream ends, and the whole is stored", async () => {
    const s = gatedStream({ streams: { buffer: 1024 } });
    const adapter = new BunHttpAdapter(0);
    adapter.get("/s", s.pages, s.handler);
    await adapter.listen(0);
    try {
      const url = `http://127.0.0.1:${adapter.listeningPort}/s`;
      const written = nextSet(s.cache);
      const miss = await fetch(url);
      expect(miss.headers.get("x-cache")).toBe("MISS");
      const reader = miss.body!.getReader();
      expect(await firstChunk(reader)).toBe("one ");
      s.open();
      expect(await rest(reader)).toBe("two");
      await written;
      const frame = await frameAt(s.cache, keyFor("/s"));
      expect(
        frame?.kind === "response" && decoder.decode(frame.response.body),
      ).toBe("one two");
      const hit = await fetch(url);
      expect(hit.headers.get("x-cache")).toBe("HIT");
      expect(hit.headers.get("etag")).toBeString();
      expect(await hit.text()).toBe("one two");
    } finally {
      await adapter.close();
    }
    expect(s.runs()).toBe(1);
  });

  test("through router.fetch(), the same", async () => {
    const s = gatedStream({ streams: { buffer: 1024 } });
    const router = new BunRouter();
    router.get("/s", s.pages, s.handler);
    const written = nextSet(s.cache);
    const miss = await router.fetch("/s");
    const reader = miss.body!.getReader();
    expect(await firstChunk(reader)).toBe("one ");
    s.open();
    expect(await rest(reader)).toBe("two");
    await written;
    const hit = await router.fetch("/s");
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("one two");
  });

  test("a stream past the buffer is sent whole and not stored; the key is marked before the client sees the end", async () => {
    const s = gatedStream({ streams: { buffer: 3 } });
    const router = new BunRouter();
    router.get("/s", s.pages, s.handler);
    // The first chunk alone outgrows the buffer: the mark is written while
    // the stream is still open, not at its end.
    const marked = nextSet(s.cache);
    const miss = await router.fetch("/s");
    expect(miss.headers.get("x-cache")).toBe("MISS");
    const reader = miss.body!.getReader();
    expect(await firstChunk(reader)).toBe("one ");
    await marked;
    expect((await frameAt(s.cache, keyFor("/s")))?.kind).toBe("uncacheable");
    s.open();
    expect(await rest(reader)).toBe("two");
    expect(s.runs()).toBe(1);
  });

  test("a request after the client saw a stream's end finds what was decided: the mark, or the entry", async () => {
    for (const coalesce of [true, false]) {
      // Past the buffer only at the last chunk: decided at the stream's end.
      const big = gatedStream(
        { streams: { buffer: 5 }, coalesce },
        "abc",
        "defg",
        slowWriteCache(40),
      );
      const router = new BunRouter();
      router.get("/s", big.pages, big.handler);
      big.open();
      expect(await (await router.fetch("/s")).text()).toBe("abcdefg");
      // Without coalescing nothing is ever marked (as for any answer).
      expect((await frameAt(big.cache, keyFor("/s")))?.kind).toBe(
        coalesce ? "uncacheable" : undefined,
      );

      const fits = gatedStream(
        { streams: { buffer: 1024 }, coalesce },
        "one ",
        "two",
        slowWriteCache(40),
      );
      const fitting = new BunRouter();
      fitting.get("/s", fits.pages, fits.handler);
      fits.open();
      expect(await (await fitting.fetch("/s")).text()).toBe("one two");
      const hit = await fitting.fetch("/s");
      expect(hit.headers.get("x-cache")).toBe("HIT");
      expect(await hit.text()).toBe("one two");
      expect(fits.runs()).toBe(1);
    }
  });

  test("text/event-stream is never stored", async () => {
    const cache = makeHttpCache();
    const router = new BunRouter();
    router.get(
      "/events",
      cacheResponse(cache, { ttl: 60_000, streams: { buffer: 1024 } }),
      async (_req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.write("data: 1\n\n");
        await res.end();
      },
    );
    const response = await router.fetch("/events");
    expect(response.headers.get("x-cache")).toBe("UNCACHEABLE");
    expect(await response.text()).toBe("data: 1\n\n");
    await Bun.sleep(5);
    expect((await frameAt(cache, keyFor("/events")))?.kind).toBe("uncacheable");
  });

  test('streams: "skip" (the default) stores no stream', async () => {
    const s = gatedStream({ ttl: 60_000 });
    const router = new BunRouter();
    router.get("/s", s.pages, s.handler);
    s.open();
    const response = await router.fetch("/s");
    expect(response.headers.get("x-cache")).toBe("UNCACHEABLE");
    expect(await response.text()).toBe("one two");
  });

  test("a client that leaves cancels the handler's stream, and nothing is stored", async () => {
    const cache = makeHttpCache();
    const adapter = new BunHttpAdapter(0);
    const cancelled = createDeferred<void>();
    adapter.get(
      "/endless",
      cacheResponse(cache, { ttl: 60_000, streams: { buffer: 1 << 20 } }),
      (_req, res) => {
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await Bun.sleep(5);
            controller.enqueue(encoder.encode("tick "));
          },
          cancel() {
            cancelled.resolve();
          },
        });
        res.send(body);
      },
    );
    await adapter.listen(0);
    try {
      const abort = new AbortController();
      const response = await fetch(
        `http://127.0.0.1:${adapter.listeningPort}/endless`,
        { signal: abort.signal },
      );
      const reader = response.body!.getReader();
      await reader.read();
      abort.abort();
      await cancelled.promise;
      await Bun.sleep(5);
      expect(await frameAt(cache, keyFor("/endless"))).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });

  test("the buffer is checked", () => {
    const cache = makeHttpCache();
    for (const streams of [
      { buffer: 0 },
      { buffer: -1 },
      { buffer: Number.NaN },
    ]) {
      expect(() => cacheResponse(cache, { streams })).toThrow(TypeError);
    }
    expect(() =>
      cacheResponse(cache, {
        streams: "all" as unknown as CacheResponseOptions["streams"],
      }),
    ).toThrow(TypeError);
  });
});

describe("tapStream", () => {
  test("copies what passes through, up to the limit", async () => {
    const source = new Blob(["ab", "cd", "ef"]).stream();
    const tapped = tapStream(source, 6);
    expect(await new Response(tapped.stream).text()).toBe("abcdef");
    const bytes = await tapped.bytes;
    expect(bytes instanceof Uint8Array && decoder.decode(bytes)).toBe("abcdef");

    const over = tapStream(new Blob(["abcdefg"]).stream(), 6);
    expect(await new Response(over.stream).text()).toBe("abcdefg");
    expect(await over.bytes).toBe("too-large");
  });

  test("a source that errors fails the copy and the stream", async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(encoder.encode("x"));
        } else {
          controller.error(new Error("broken"));
        }
      },
    });
    const tapped = tapStream(source, 100);
    await expect(new Response(tapped.stream).text()).rejects.toThrow("broken");
    expect(await tapped.bytes).toBe("failed");
  });

  test("reads the source only as the stream is read", async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(encoder.encode("x"));
        },
      },
      { highWaterMark: 0 },
    );
    const tapped = tapStream(source, 100);
    const reader = tapped.stream.getReader();
    await reader.read();
    await Bun.sleep(5);
    expect(pulls).toBe(1);
    await reader.cancel();
    expect(await tapped.bytes).toBe("failed");
  });
});
