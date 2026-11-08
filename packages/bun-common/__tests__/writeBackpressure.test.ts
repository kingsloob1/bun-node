/**
 * `res.write()` backpressure (bun-native-routes plan §16.9, S10): the
 * long-lived stream is a 64 KiB byte-length queue, `write()` answers `false`
 * once it is full, as Node's does, and `drain` follows when the client has
 * read it back under the mark. Socket-free (`router.fetch()`, a body nobody
 * reads yet) and served (a client that stops reading).
 */
import type { BunResponse } from "../lib/BunResponse";
import { Buffer } from "node:buffer";
import net from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { makeResponse } from "./helpers";

const MARK = 64 * 1024;
const KIB = new Uint8Array(1024).fill(120);

/** Resolves with the next `drain` on `res`. */
function nextDrain(res: BunResponse): Promise<void> {
  return new Promise((resolve) => res.once("drain", () => resolve()));
}

/**
 * A router whose `/w` opens a streamed response (`flushHeaders()`), hands it
 * to `onResponse` and leaves it open.
 */
function capturing(onResponse: (res: BunResponse) => void): BunRouter {
  const router = new BunRouter();
  router.get("/w", (_req, res) => {
    res.setHeader("Content-Type", "application/octet-stream");
    res.flushHeaders();
    onResponse(res);
  });
  return router;
}

/** Reads `body` to the end and returns every byte. */
async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

describe("res.write() backpressure, the queue", () => {
  // A response built without a server: nothing reads its stream, so the
  // queue holds exactly what was written.
  it("answers true under the mark and false at it, with writableLength and writableNeedDrain", async () => {
    const res = await makeResponse();
    expect(res.writableLength).toBe(0);
    expect(res.writableNeedDrain).toBe(false);

    const answers: boolean[] = [];
    for (let i = 0; i < 64; i++) {
      answers.push(res.write(KIB));
    }
    // 63 KiB queued: still under; the 64th fills it.
    expect(answers.slice(0, 63).every(Boolean)).toBe(true);
    expect(answers[63]).toBe(false);
    expect(res.writableNeedDrain).toBe(true);
    expect(res.writableLength).toBe(MARK);
    // Past the mark the chunk is still queued (nothing is dropped).
    expect(res.write("more")).toBe(false);
    expect(res.writableLength).toBe(MARK + 4);
  });

  it("text is counted in UTF-8 bytes", async () => {
    const res = await makeResponse();
    // "€" is three bytes: 21,845 of them is 65,535 bytes, one under the mark.
    expect(res.write("€".repeat(21_845))).toBe(true);
    expect(res.writableLength).toBe(MARK - 1);
    expect(res.write("x")).toBe(false);
  });

  it("an empty write neither fills the queue nor answers false", async () => {
    const res = await makeResponse();
    expect(res.write("")).toBe(true);
    expect(res.write(new Uint8Array(0))).toBe(true);
    expect(res.writableLength).toBe(0);
  });
});

describe("res.write() backpressure, socket-free", () => {
  it("emits drain once the reader takes the queue under the mark, and delivers every byte in order", async () => {
    let res!: BunResponse;
    const opened = Promise.withResolvers<void>();
    const router = capturing((r) => {
      res = r;
      r.write("start:");
      opened.resolve();
    });
    const response = await router.fetch("/w");
    await opened.promise;

    let written = 6;
    const expected: number[] = Array.from(new TextEncoder().encode("start:"));
    const write = (i: number): boolean => {
      const chunk = new Uint8Array(1000).fill(i % 251);
      written += chunk.byteLength;
      expected.push(...chunk);
      return res.write(chunk);
    };
    let i = 0;
    while (write(i++)) {
      // Fill the queue.
    }
    expect(written).toBeGreaterThanOrEqual(MARK);
    expect(written).toBeLessThan(MARK + 1000);
    expect(res.writableNeedDrain).toBe(true);

    let drains = 0;
    res.on("drain", () => drains++);
    const reader = response.body!.getReader();
    const received: number[] = [];
    const first = await reader.read();
    received.push(...first.value!);
    // The reader took a chunk: the queue is under the mark again.
    await Promise.resolve();
    expect(drains).toBe(1);
    expect(res.writableNeedDrain).toBe(false);

    // A second round: fill again, then end, and read everything.
    while (write(i++)) {
      // Fill the queue.
    }
    void res.end();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(...value);
    }
    expect(drains).toBe(2);
    expect(received.length).toBe(expected.length);
    expect(Buffer.from(received).equals(Buffer.from(expected))).toBe(true);
  });

  it("a Readable piped into res is paced by write()'s answer and drain, and arrives intact", async () => {
    const total = 4 * 1024 * 1024;
    const source = Buffer.alloc(total);
    for (let i = 0; i < total; i++) source[i] = (i * 7) % 256;
    let falses = 0;
    const router = capturing((res) => {
      const write = res.write.bind(res);
      res.write = ((chunk: Parameters<BunResponse["write"]>[0]) => {
        const ok = write(chunk);
        if (!ok) falses++;
        return ok;
      }) as BunResponse["write"];
      // A 16 KiB chunk at a time, as a file stream reads.
      Readable.from(
        (function* () {
          for (let at = 0; at < total; at += 16 * 1024) {
            yield source.subarray(at, at + 16 * 1024);
          }
        })(),
      )
        .on("end", () => void res.end())
        .pipe(res as unknown as NodeJS.WritableStream, { end: false });
    });
    const body = await readAll((await router.fetch("/w")).body!);
    expect(body.byteLength).toBe(total);
    expect(Buffer.from(body).equals(source)).toBe(true);
    // The pipe met backpressure and waited for drain, rather than buffering all.
    expect(falses).toBeGreaterThan(0);
  });

  it("after end() or the client leaving, write() answers false and queues nothing", async () => {
    let res!: BunResponse;
    const router = capturing((r) => {
      res = r;
      r.write("x");
    });
    const response = await router.fetch("/w");
    await response.body!.cancel();
    await Promise.resolve();
    res.on("error", () => {});
    expect(res.write("late")).toBe(false);
    expect(res.writableLength).toBe(0);
  });
});

describe("res.write() backpressure, served", () => {
  it("a producer that waits for drain buffers about the mark while its client stops reading", async () => {
    const app = new BunHttpAdapter(0, { logger: () => {} });
    let accepted = 0;
    // Writes that answered false; an object, as the loops below read it
    // across awaits.
    const seen = { refused: 0 };
    const total = 16 * 1024 * 1024;
    const finished = Promise.withResolvers<void>();
    app.get("/s", async (_req, res) => {
      res.setHeader("Content-Type", "application/octet-stream");
      while (accepted < total && !res.writableEnded) {
        accepted += KIB.byteLength;
        if (!res.write(KIB)) {
          seen.refused++;
          await nextDrain(res);
        }
      }
      await res.end();
      finished.resolve();
    });
    await app.listen(0);
    const socket = net.createConnection({
      port: app.listeningPort,
      host: "127.0.0.1",
    });
    let received = 0;
    try {
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.pause();
      socket.write("GET /s HTTP/1.1\r\nHost: test\r\n\r\n");
      // Wait until the producer has met backpressure and stopped moving: the
      // client reads nothing, so what was accepted is the mark plus what the
      // kernel and Bun buffer. (Writing regardless, it would reach `total`.)
      let last = -1;
      while (seen.refused === 0 || accepted !== last) {
        last = accepted;
        await Bun.sleep(200);
      }
      expect(accepted).toBeLessThan(total / 2);

      // The client reads again: the producer resumes and finishes.
      socket.on("data", (data: Buffer) => {
        received += data.byteLength;
      });
      socket.resume();
      await finished.promise;
      expect(accepted).toBe(total);
    } finally {
      socket.destroy();
      await app.close();
    }
    expect(received).toBeGreaterThan(0);
  });
});
