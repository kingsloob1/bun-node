/**
 * The prototype helpers end to end: wire format, served and socket-free
 * (`fetch()`), compression, disconnect, the slow-consumer bound, and an
 * error mid-stream.
 *
 *   bun test docs/plans/evidence/bun-native-routes/sse/prototype-sse.test.ts
 */
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter, BunRouter, compression, noopLogger } from "@kingsleyweb/bun-common";
import { readEvents } from "./lib";
import { formatSseEvent, sse, sseResponse, SseStream } from "./prototype-sse";

describe("formatSseEvent", () => {
  it("splits data on CRLF, CR and LF, one data: line each", () => {
    expect(formatSseEvent({ data: "a\r\nb\rc\nd" })).toBe("data: a\ndata: b\ndata: c\ndata: d\n\n");
  });
  it("serialises non-strings as JSON, keeps empty string and 0", () => {
    expect(formatSseEvent({ data: { n: 1 } })).toBe('data: {"n":1}\n\n');
    expect(formatSseEvent({ data: "" })).toBe("data: \n\n");
    expect(formatSseEvent({ data: 0 })).toBe("data: 0\n\n");
  });
  it("orders comment, event, id, retry, data", () => {
    expect(formatSseEvent({ comment: "c", event: "e", id: 7, retry: 1000, data: "x" })).toBe(
      ": c\nevent: e\nid: 7\nretry: 1000\ndata: x\n\n",
    );
  });
  it("refuses a field that would break framing", () => {
    expect(() => formatSseEvent({ event: "a\nb" })).toThrow(TypeError);
    expect(() => formatSseEvent({ id: "a\0" })).toThrow(TypeError);
    expect(() => formatSseEvent({ retry: -1 })).toThrow(TypeError);
  });
});

describe("helpers through the adapter", () => {
  it("router.fetch() streams sseResponse events as they are sent", async () => {
    const r = new BunRouter();
    r.get("/e", (_q, res) => {
      res.send(sseResponse(async function* () {
        for (let i = 1; i <= 3; i++) {
          await Bun.sleep(100);
          yield { id: i, data: { i } };
        }
      }(), { heartbeatMs: 0 }));
    });
    const t0 = performance.now();
    const res = await r.fetch("/e");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const out = await readEvents(res.body, t0);
    expect(out.events.map((e) => e.block)).toEqual([": ok", 'id: 1\ndata: {"i":1}', 'id: 2\ndata: {"i":2}', 'id: 3\ndata: {"i":3}']);
    expect(out.events[0].at).toBeLessThan(50);
    expect(out.events[3].at).toBeGreaterThan(250);
    expect(out.end).toBe("done");
  });

  it("sse(req, res) served: compression() flushes each event", async () => {
    const a = new BunHttpAdapter(0, { logger: noopLogger });
    a.use(compression({ threshold: 0 }));
    a.get("/e", (req, res) => {
      const s = sse(req, res, { heartbeatMs: 0 });
      void (async () => {
        for (let i = 1; i <= 3; i++) {
          await Bun.sleep(100);
          await s.send({ data: `e${i}` });
        }
        s.close();
      })();
    });
    const server = await a.listen(0);
    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${server.port}/e`, { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const out = await readEvents(res.body, t0);
    await a.close();
    expect(out.events.map((e) => e.block)).toEqual([": ok", "data: e1", "data: e2", "data: e3"]);
    // Each event arrives ~100 ms after the previous one, not all at the end.
    expect(out.events[1].at).toBeLessThan(out.events[3].at - 150);
  });

  it("TODAY'S GAP: in bun-common, a handler that awaits its stream holds the whole response until it returns", async () => {
    const a = new BunHttpAdapter(0, { logger: noopLogger });
    a.get("/e", async (req, res) => {
      const s = sse(req, res, { heartbeatMs: 0 });
      for (let i = 1; i <= 3; i++) {
        await Bun.sleep(100);
        await s.send({ data: `e${i}` });
      }
      s.close();
    });
    const server = await a.listen(0);
    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${server.port}/e`);
    const out = await readEvents(res.body, t0);
    await a.close();
    // ": ok" was enqueued at once, yet arrives with the rest at ~300 ms.
    expect(out.events[0].at).toBeGreaterThan(250);
  });

  it("a client disconnect closes the stream and send() reports false", async () => {
    const a = new BunHttpAdapter(0, { logger: noopLogger });
    const closed = Promise.withResolvers<boolean>();
    a.get("/e", (req, res) => {
      const s = sse(req, res, { heartbeatMs: 0 });
      s.onClose(async () => closed.resolve(await s.send({ data: "late" })));
      const t = setInterval(() => void s.send({ data: "x" }), 20);
      s.onClose(() => clearInterval(t));
    });
    const server = await a.listen(0);
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/e`, { signal: ac.signal });
    await readEvents(res.body, performance.now(), { max: 3 });
    ac.abort();
    expect(await closed.promise).toBe(false);
    await a.close();
  });

  it("a client that stops reading is closed at maxQueuedBytes, not buffered without bound", async () => {
    const s = new SseStream({ heartbeatMs: 0, maxQueuedBytes: 1024 * 1024, open: false });
    // Nobody reads `s.readable`.
    const payload = "x".repeat(1000);
    let sent = 0;
    while (!s.closed && sent < 10_000) {
      void s.send({ data: payload });
      sent++;
    }
    expect(s.closed).toBe(true);
    // 1 MiB of ~1 KB events plus the 64 KiB high-water mark.
    expect(sent).toBeLessThan(1200);
  });

  it("an error from the source becomes an `event: error`, then the stream ends", async () => {
    const res = sseResponse(async function* () {
      yield { data: "e1" };
      throw new Error("boom");
    }(), { heartbeatMs: 0, open: false });
    const out = await readEvents(res.body, performance.now());
    expect(out.events.map((e) => e.block)).toEqual(["data: e1", "event: error\ndata: boom"]);
    expect(out.end).toBe("done");
  });
});
