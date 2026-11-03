/**
 * Live invalidation's server half (`lib/live/`, typed-client plan
 * `websocket.md` §9, PR-W4), served for real on port 0 and driven by a raw
 * WebSocket or `fetch` client, so nothing of bun-client is involved (its
 * `live()` is tested end to end in bun-client's `live.test.ts`).
 *
 * Covered: `subscribe` answered with `hello`; `publishTags` reaching the
 * holders of a tag and nobody else (control: an unsubscribed tag), one frame
 * per tag with the invalidation's `seq`; refcounted topics (Bun's
 * `subscriberCount` follows subscribe, unsubscribe and close); resume
 * replaying what a socket missed, and a `gap` for another epoch, a cursor
 * ahead of the server and one off the ring (control: one still on it); a
 * route's `cache.invalidates` on a 2xx (control: a 4xx, and a route without
 * one); a source's `invalidate` event; `authorize` on both endpoints; the
 * SSE fallback on bun-common's writer (`res.sse()`) with `Last-Event-ID`;
 * the documents; the contract's browser
 * safety (control: the server module is caught).
 */
import type { Server } from "bun";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import { generateAsyncApi, generateOpenApi } from "../lib/docs/index";
import { ConfigError } from "../lib/errors";
import { createTestLogger } from "../lib/logging";
import { liveContract, liveInvalidation, publishTags } from "../lib/live";
import { fillTagTemplates, restartLiveEpoch } from "../lib/live/server";

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

/** A frame as the client sees it. */
interface Frame {
  type: string;
  id?: string;
  data?: Record<string, unknown>;
}

/** A raw live client: its frames, and `request()` answered by the echoed id. */
async function socketOf(url: string) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  let next = 0;
  ws.onmessage = (event) =>
    void frames.push(JSON.parse(String(event.data)) as Frame);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`${url} did not open`));
  });
  const request = async (type: string, data: unknown): Promise<Frame> => {
    const id = `r${++next}`;
    ws.send(JSON.stringify({ type, id, data }));
    let reply: Frame | undefined;
    await until(() => {
      reply = frames.find((frame) => frame.id === id);
      return reply !== undefined;
    });
    return reply!;
  };
  /** The `invalidate` frames so far, as `[seq, tags]`. */
  const invalidations = () =>
    frames
      .filter((frame) => frame.type === "invalidate")
      .map((frame) => [frame.data?.seq, frame.data?.tags]);
  return { ws, frames, request, invalidations };
}

/** An app with live invalidation mounted first, and its routes. */
async function serve(
  options: {
    authorize?: Parameters<typeof liveInvalidation>[1]["authorize"];
    source?: Parameters<typeof liveInvalidation>[1]["source"];
  } = {},
) {
  const { logger } = createTestLogger();
  const adapter = new BunHttpAdapter(0, { logger });
  adapter.use(
    liveInvalidation(adapter, {
      authorize: options.authorize ?? ((_req, _res, next) => next()),
      source: options.source,
    }),
  );
  const Params = z.object({ id: z.string() });
  adapter
    .patch("/users/:id", validate({ params: Params }), (req, res) => {
      if (req.params.id === "missing") {
        res.status(404).json({ error: "no such user" });
        return;
      }
      res.json({ id: req.params.id });
    })
    .describe({ cache: { invalidates: ["user:{id}", "users", "org:{org}"] } });
  adapter.post("/plain", (_req, res) => {
    res.json({ ok: true });
  });
  const server = (await adapter.listen(0)) as Server<unknown>;
  const base = `127.0.0.1:${server.port}`;
  return {
    adapter,
    server,
    http: `http://${base}`,
    ws: `ws://${base}${liveContract.meta.path}`,
    close: () => adapter.close(),
  };
}

/** A unique tag, so the process's shared hub never mixes two tests' tags. */
let tagCount = 0;
const fresh = (name: string): string => `${name}-${++tagCount}-${Date.now()}`;

describe("the channel", () => {
  it("answers subscribe with hello, and sends each holder of a tag its invalidation", async () => {
    const app = await serve();
    try {
      const a = fresh("a");
      const b = fresh("b");
      const one = await socketOf(app.ws);
      const two = await socketOf(app.ws);
      const hello = await one.request("subscribe", { tags: [a, b] });
      expect(hello.type).toBe("hello");
      expect(typeof hello.data?.epoch).toBe("string");
      expect(typeof hello.data?.seq).toBe("number");
      await two.request("subscribe", { tags: [b] });
      publishTags([a, b, fresh("nobody")]);
      await until(
        () =>
          one.invalidations().length === 2 && two.invalidations().length === 1,
      );
      const seq = (hello.data!.seq as number) + 1;
      // One frame per tag, each with the invalidation's seq.
      expect(
        one
          .invalidations()
          .sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
      ).toEqual([
        [seq, [a]],
        [seq, [b]],
      ]);
      // The control: `two` holds only `b`.
      expect(two.invalidations()).toEqual([[seq, [b]]]);
      one.ws.close();
      two.ws.close();
    } finally {
      await app.close();
    }
  });

  it("refcounts a tag's topic: joined by subscribe, left by unsubscribe and close", async () => {
    const app = await serve();
    try {
      const tag = fresh("t");
      const topic = `bun-common/live:${tag}`;
      const one = await socketOf(app.ws);
      const two = await socketOf(app.ws);
      await one.request("subscribe", { tags: [tag] });
      await two.request("subscribe", { tags: [tag, tag] });
      expect(app.server.subscriberCount(topic)).toBe(2);
      two.ws.send(
        JSON.stringify({ type: "unsubscribe", data: { tags: [tag] } }),
      );
      await until(() => app.server.subscriberCount(topic) === 1);
      publishTags([tag]);
      await until(() => one.invalidations().length === 1);
      await Bun.sleep(30);
      expect(two.invalidations()).toEqual([]);
      one.ws.close();
      await until(() => app.server.subscriberCount(topic) === 0);
      two.ws.close();
    } finally {
      await app.close();
    }
  });

  it("refuses a malformed subscribe with the channel's error frame", async () => {
    const app = await serve();
    try {
      const one = await socketOf(app.ws);
      const reply = await one.request("subscribe", { tags: [] });
      expect(reply.type).toBe("error");
      expect((reply as unknown as { code: string }).code).toBe("VALIDATION");
      one.ws.close();
    } finally {
      await app.close();
    }
  });
});

describe("resume", () => {
  it("replays what a reconnecting socket missed, for the tags it holds, before the resume's hello", async () => {
    const app = await serve();
    try {
      const tag = fresh("r");
      const other = fresh("o");
      const first = await socketOf(app.ws);
      const hello = (await first.request("subscribe", { tags: [tag] })).data!;
      first.ws.close();
      publishTags([tag]);
      publishTags([other]);
      publishTags([tag, other]);
      const again = await socketOf(app.ws);
      await again.request("subscribe", { tags: [tag] });
      const reply = await again.request("resume", {
        epoch: hello.epoch,
        seq: hello.seq,
      });
      const seq = hello.seq as number;
      expect(again.invalidations()).toEqual([
        [seq + 1, [tag]],
        [seq + 3, [tag]],
      ]);
      // Replayed before the reply, which says where the server is now.
      const order = again.frames.map((frame) => frame.type);
      expect(order.lastIndexOf("invalidate")).toBeLessThan(
        order.lastIndexOf("hello"),
      );
      expect(reply.data).toEqual({ epoch: hello.epoch, seq: seq + 3 });
      expect(again.frames.some((frame) => frame.type === "gap")).toBe(false);
      again.ws.close();
    } finally {
      await app.close();
    }
  });

  it("sends a gap for another epoch, a cursor ahead of the server, or one off the ring", async () => {
    const app = await serve();
    try {
      const tag = fresh("g");
      const probe = await socketOf(app.ws);
      const now = (await probe.request("subscribe", { tags: [tag] })).data!;

      const otherEpoch = await socketOf(app.ws);
      await otherEpoch.request("resume", { epoch: "another", seq: 0 });
      expect(otherEpoch.frames[0]?.type).toBe("gap");
      expect(otherEpoch.frames[0]?.data).toEqual(now);

      const ahead = await socketOf(app.ws);
      await ahead.request("resume", {
        epoch: now.epoch,
        seq: (now.seq as number) + 5,
      });
      expect(ahead.frames[0]?.type).toBe("gap");

      // 1024 invalidations fit; the 1025th pushes the cursor's next one out.
      for (let i = 0; i < 1024; i++) publishTags([fresh("fill")]);
      const onRing = await socketOf(app.ws);
      await onRing.request("resume", now);
      expect(onRing.frames.map((frame) => frame.type)).toEqual(["hello"]);
      publishTags([fresh("fill")]);
      const offRing = await socketOf(app.ws);
      await offRing.request("resume", now);
      expect(offRing.frames.map((frame) => frame.type)).toEqual([
        "gap",
        "hello",
      ]);

      // A restarted process (a new epoch) gaps every old cursor.
      restartLiveEpoch();
      const restarted = await socketOf(app.ws);
      const reply = await restarted.request("resume", now);
      expect(restarted.frames[0]?.type).toBe("gap");
      expect(reply.data?.epoch).not.toBe(now.epoch);
      expect(reply.data?.seq).toBe(0);
      for (const socket of [
        probe,
        otherEpoch,
        ahead,
        onRing,
        offRing,
        restarted,
      ])
        socket.ws.close();
    } finally {
      await app.close();
    }
  });
});

describe("sources", () => {
  it("publishes a route's cache.invalidates, filled from its params, on a 2xx only", async () => {
    const app = await serve();
    try {
      const id = fresh("u");
      const watcher = await socketOf(app.ws);
      await watcher.request("subscribe", {
        tags: [`user:${id}`, "users", "user:missing"],
      });
      const missing = await fetch(`${app.http}/users/missing`, {
        method: "PATCH",
      });
      expect(missing.status).toBe(404);
      const plain = await fetch(`${app.http}/plain`, { method: "POST" });
      expect(plain.status).toBe(200);
      await Bun.sleep(30);
      // The controls: a 404, and a route that declares nothing.
      expect(watcher.invalidations()).toEqual([]);
      const ok = await fetch(`${app.http}/users/${id}`, { method: "PATCH" });
      expect(ok.status).toBe(200);
      await until(() => watcher.invalidations().length === 2);
      const tags = watcher
        .invalidations()
        .map(([, tags]) => (tags as string[])[0]);
      // "org:{org}" names no param of the route, so it is skipped.
      expect(tags.sort()).toEqual([`user:${id}`, "users"].sort());
      watcher.ws.close();
    } finally {
      await app.close();
    }
  });

  it("publishes a source's tag invalidations", async () => {
    const listeners: ((event: { tags: readonly string[] }) => void)[] = [];
    const app = await serve({
      source: {
        on: (_event, listener) => {
          listeners.push(listener);
          return () => {};
        },
      },
    });
    try {
      const tag = fresh("c");
      const watcher = await socketOf(app.ws);
      await watcher.request("subscribe", { tags: [tag] });
      expect(listeners.length).toBe(1);
      listeners[0]!({ tags: [tag, ""] });
      await until(() => watcher.invalidations().length === 1);
      expect(watcher.invalidations()[0]![1]).toEqual([tag]);
      watcher.ws.close();
    } finally {
      await app.close();
    }
  });

  it("fills templates as the client does: a missing param skips the tag", () => {
    expect(
      fillTagTemplates(["user:{id}", "org:{org}", "all", "user:{id}"], {
        id: 7,
      }),
    ).toEqual(["user:7", "all"]);
  });

  it("refuses a tag that is not a 1 to 512 character string", () => {
    expect(() => publishTags([""])).toThrow(TypeError);
    expect(() => publishTags(["x".repeat(513)])).toThrow(TypeError);
    expect(() => publishTags([7 as unknown as string])).toThrow(TypeError);
    expect(() => publishTags("tag" as unknown as string[])).toThrow(TypeError);
  });
});

describe("authorize", () => {
  it("is required", () => {
    const app = new BunHttpAdapter(0);
    expect(() =>
      liveInvalidation(app, {} as Parameters<typeof liveInvalidation>[1]),
    ).toThrow(ConfigError);
  });

  it("runs before the upgrade and before the SSE fallback", async () => {
    const app = await serve({
      authorize: (req, res, next) => {
        if (req.query.token === "yes") next();
        else res.status(401).json({ error: "who are you" });
      },
    });
    try {
      const refused = await fetch(`${app.http}/__live/sse?tag=x`);
      expect(refused.status).toBe(401);
      const upgrade = new WebSocket(app.ws);
      const code = await new Promise<number>((resolve) => {
        upgrade.onclose = (event) => resolve(event.code);
      });
      expect(code).not.toBe(1000);
      const allowed = await socketOf(`${app.ws}?token=yes`);
      expect((await allowed.request("subscribe", { tags: ["x"] })).type).toBe(
        "hello",
      );
      allowed.ws.close();
    } finally {
      await app.close();
    }
  });
});

/** Reads an SSE response's events until `count` have arrived (or the stream ends). */
async function readEvents(response: Response, count: number) {
  const reader = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();
  const events: { event: string; id: string; data: unknown }[] = [];
  let buffer = "";
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    for (
      let end = buffer.indexOf("\n\n");
      end >= 0;
      end = buffer.indexOf("\n\n")
    ) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith(":")) continue;
      const field = (name: string) =>
        block
          .split("\n")
          .find((line) => line.startsWith(`${name}: `))
          ?.slice(name.length + 2) ?? "";
      events.push({
        event: field("event"),
        id: field("id"),
        data: JSON.parse(field("data")),
      });
    }
  }
  return { events, cancel: () => reader.cancel() };
}

describe("the SSE fallback", () => {
  it("streams hello, then its tags' invalidations, each with <epoch>:<seq> as its id", async () => {
    const app = await serve();
    try {
      const a = fresh("s");
      const controller = new AbortController();
      const response = await fetch(
        `${app.http}/__live/sse?tag=${encodeURIComponent(a)}&tag=x`,
        { signal: controller.signal },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      // bun-common's SSE writer (res.sse()): its headers.
      expect(response.headers.get("cache-control")).toBe(
        "no-cache, no-transform",
      );
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      const reading = readEvents(response, 2);
      await Bun.sleep(30);
      publishTags([fresh("not-mine")]);
      publishTags([a]);
      const { events } = await reading;
      expect(events[0]!.event).toBe("hello");
      const hello = events[0]!.data as { epoch: string; seq: number };
      expect(events[0]!.id).toBe(`${hello.epoch}:${hello.seq}`);
      expect(events[1]).toEqual({
        event: "invalidate",
        id: `${hello.epoch}:${hello.seq + 2}`,
        data: { tags: [a], seq: hello.seq + 2, epoch: hello.epoch },
      });
      controller.abort();
    } finally {
      await app.close();
    }
  });

  it("resumes from Last-Event-ID, or answers a gap", async () => {
    const app = await serve();
    try {
      const a = fresh("l");
      const first = await fetch(`${app.http}/__live/sse?tag=${a}`);
      const opened = await readEvents(first, 1);
      const hello = opened.events[0]!.data as { epoch: string; seq: number };
      await opened.cancel();
      publishTags([a]);
      const resumed = await fetch(`${app.http}/__live/sse?tag=${a}`, {
        headers: { "last-event-id": `${hello.epoch}:${hello.seq}` },
      });
      const replay = await readEvents(resumed, 2);
      expect(replay.events.map((event) => event.event)).toEqual([
        "invalidate",
        "hello",
      ]);
      await replay.cancel();
      const gapped = await fetch(`${app.http}/__live/sse?tag=${a}`, {
        headers: { "last-event-id": `another:3` },
      });
      const gap = await readEvents(gapped, 2);
      expect(gap.events.map((event) => event.event)).toEqual(["gap", "hello"]);
      await gap.cancel();
      // An id this process cannot read is a gap too.
      const unreadable = await fetch(`${app.http}/__live/sse?tag=${a}`, {
        headers: { "last-event-id": "7" },
      });
      const unread = await readEvents(unreadable, 2);
      expect(unread.events.map((event) => event.event)).toEqual([
        "gap",
        "hello",
      ]);
      await unread.cancel();
    } finally {
      await app.close();
    }
  });

  it("answers 400 without a tag", async () => {
    const app = await serve();
    try {
      expect((await fetch(`${app.http}/__live/sse`)).status).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("the documents", () => {
  it("documents the channel and its fallback in AsyncAPI, and hides the SSE route from OpenAPI", async () => {
    const app = new BunHttpAdapter(0);
    app.use(liveInvalidation(app, { authorize: (_req, _res, next) => next() }));
    const asyncapi = generateAsyncApi(app, {
      title: "t",
      version: "1",
    }).document;
    const text = JSON.stringify(asyncapi);
    expect(text).toContain("/__live");
    expect(text).toContain('"x-bun-common-sse-fallback":"/__live/sse"');
    for (const type of [
      "subscribe",
      "unsubscribe",
      "resume",
      "invalidate",
      "gap",
      "hello",
    ])
      expect(text).toContain(type);
    const openapi = generateOpenApi(app, { title: "t", version: "1" }).document;
    expect(Object.keys(openapi.paths ?? {})).not.toContain("/__live/sse");
  });

  it("serves only the fallback on a router with no BunWebSocket, saying so", () => {
    const { logger, events } = createTestLogger();
    const router = new BunRouter({ logger });
    liveInvalidation(router, { authorize: (_req, _res, next) => next() });
    expect(events.some((event) => event.level === "warn")).toBe(true);
  });
});

describe("browser safety", () => {
  /** Text only server code contains. */
  const SERVER = [/["'`](?:node|bun):[\w/]+["'`]/, /\bBun\.\w+/, /\brequire\(/];
  const LIB = resolve(import.meta.dir, "../lib");

  /** Bundles `entry` for a browser; the bun-common modules it pulled in and the server markers found. */
  async function bundle(entry: string) {
    const modules: string[] = [];
    const result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      throw: false,
      plugins: [
        {
          name: "record",
          setup(build) {
            build.onLoad({ filter: /\.ts$/ }, async (args) => {
              if (args.path.startsWith(LIB))
                modules.push(relative(LIB, args.path));
              return {
                contents: await Bun.file(args.path).text(),
                loader: "ts",
              };
            });
          },
        },
      ],
    });
    const code = result.success ? await result.outputs[0]!.text() : "";
    return {
      success: result.success,
      modules,
      markers: SERVER.filter((marker) => marker.test(code)).map(
        (m) => m.source,
      ),
    };
  }

  it("bundles the contract for a browser with none of bun-common's server code", async () => {
    const built = await bundle(resolve(LIB, "live/contract.ts"));
    expect(built.success).toBe(true);
    expect(built.markers).toEqual([]);
    expect(built.modules.sort()).toEqual([
      "contract/channel.ts",
      "live/contract.ts",
    ]);
  });

  it("the control: the server module is caught", async () => {
    const built = await bundle(resolve(LIB, "live/server.ts"));
    expect(built.modules).toContain("BunRouter.ts");
  });
});
