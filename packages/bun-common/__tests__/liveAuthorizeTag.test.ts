/**
 * Per-tag live authorization (`liveInvalidation()`'s `authorizeTag`), served
 * for real on port 0 and driven by raw WebSocket and `fetch` clients.
 *
 * The hook here allows `tenant:<n>` only to a client whose upgrade (or SSE)
 * request says `?tenant=<n>`, and every other tag to everyone. Covered: a
 * refused tag is never delivered on the channel, live or by resume, and is
 * listed in the `subscribe`'s `hello.denied` (control: the same app without
 * the hook delivers it); an asynchronous hook, with what was published while
 * it ran replayed for the allowed tags; a throwing or rejecting hook refuses
 * (and logs); a held tag is not asked again; the SSE fallback (`hello.denied`,
 * never delivered, never replayed from `Last-Event-ID`; `403` problem+json
 * when every tag is refused, control: one allowed tag opens it); a socket
 * kept open when a subscribe's every tag is refused; the option's check and
 * the contract's `denied`.
 */
import type { Server } from "bun";
import { describe, expect, it } from "bun:test";
import type { AuthorizeTag } from "../lib/live";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { ConfigError } from "../lib/errors";
import { createTestLogger } from "../lib/logging";
import { liveContract, liveInvalidation, publishTags } from "../lib/live";

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

/** A raw live client. */
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
  /** The tags of the `invalidate` frames so far. */
  const delivered = () =>
    frames
      .filter((frame) => frame.type === "invalidate")
      .flatMap((frame) => frame.data?.tags as string[]);
  return { ws, frames, request, delivered };
}

/** A unique run id, so the process's shared hub never mixes two tests' tags. */
let count = 0;
const fresh = (): string => `${++count}-${Date.now()}`;

/** The tenant rule: `tenant:<n>` for `?tenant=<n>` only. */
const byTenant: AuthorizeTag = (tag, req) =>
  !tag.startsWith("tenant:") || tag === `tenant:${String(req.query.tenant)}`;

/** An app with live invalidation, `authorizeTag` as given. */
async function serve(authorizeTag?: AuthorizeTag) {
  const { logger, events } = createTestLogger();
  const adapter = new BunHttpAdapter(0, { logger });
  adapter.use(
    liveInvalidation(adapter, {
      authorize: (_req, _res, next) => next(),
      authorizeTag,
    }),
  );
  const server = (await adapter.listen(0)) as Server<unknown>;
  const base = `127.0.0.1:${server.port}`;
  return {
    events,
    http: `http://${base}`,
    ws: `ws://${base}${liveContract.meta.path}`,
    close: () => adapter.close(),
  };
}

/** Reads an SSE response's events as they arrive. */
function readEvents(response: Response) {
  const list: { event: string; id: string; data: Record<string, unknown> }[] =
    [];
  void (async () => {
    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
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
          list.push({
            event: field("event"),
            id: field("id"),
            data: JSON.parse(field("data")) as Record<string, unknown>,
          });
        }
      }
    } catch {
      // Aborted.
    }
  })();
  return { list };
}

describe("authorizeTag on the channel", () => {
  it("never delivers a refused tag, and lists it in the subscribe's hello", async () => {
    const run = fresh();
    const mine = `tenant:${run}`;
    const theirs = `tenant:other-${run}`;
    const open = `public:${run}`;
    const app = await serve(byTenant);
    const control = await serve();
    try {
      const socket = await socketOf(`${app.ws}?tenant=${run}`);
      const hello = await socket.request("subscribe", {
        tags: [mine, theirs, open],
      });
      expect(hello.type).toBe("hello");
      expect(hello.data!.denied).toEqual([theirs]);
      // The control: the same subscribe without the hook holds every tag.
      const unguarded = await socketOf(`${control.ws}?tenant=${run}`);
      const plain = await unguarded.request("subscribe", {
        tags: [mine, theirs, open],
      });
      expect(plain.data!.denied).toBeUndefined();
      publishTags([theirs]);
      publishTags([mine, theirs, open]);
      await until(
        () =>
          socket.delivered().length === 2 && unguarded.delivered().length === 4,
      );
      await Bun.sleep(30);
      expect(socket.delivered().sort()).toEqual([mine, open].sort());
      expect(unguarded.delivered().filter((t) => t === theirs).length).toBe(2);
      socket.ws.close();
      unguarded.ws.close();
    } finally {
      await app.close();
      await control.close();
    }
  });

  it("never replays a refused tag on resume", async () => {
    const run = fresh();
    const mine = `tenant:${run}`;
    const theirs = `tenant:other-${run}`;
    const app = await serve(byTenant);
    try {
      const first = await socketOf(`${app.ws}?tenant=${run}`);
      const cursor = (
        await first.request("subscribe", { tags: [mine, theirs] })
      ).data!;
      first.ws.close();
      publishTags([theirs]);
      publishTags([mine]);
      publishTags([theirs, mine]);
      const again = await socketOf(`${app.ws}?tenant=${run}`);
      const hello = await again.request("subscribe", { tags: [mine, theirs] });
      expect(hello.data!.denied).toEqual([theirs]);
      await again.request("resume", {
        epoch: cursor.epoch,
        seq: cursor.seq,
      });
      expect(again.delivered()).toEqual([mine, mine]);
      again.ws.close();
    } finally {
      await app.close();
    }
  });

  it("waits for an asynchronous hook, replaying what was published under the allowed tags meanwhile", async () => {
    const run = fresh();
    const mine = `tenant:${run}`;
    const theirs = `tenant:other-${run}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await serve(async (tag, req) => {
      await gate;
      return byTenant(tag, req);
    });
    try {
      const socket = await socketOf(`${app.ws}?tenant=${run}`);
      const id = "slow";
      socket.ws.send(
        JSON.stringify({
          type: "subscribe",
          id,
          data: { tags: [mine, theirs] },
        }),
      );
      await Bun.sleep(30);
      // Published while the check runs: not held yet.
      publishTags([mine, theirs]);
      release();
      await until(() => socket.frames.some((frame) => frame.id === id));
      const hello = socket.frames.find((frame) => frame.id === id)!;
      expect(hello.data!.denied).toEqual([theirs]);
      // Replayed, before the hello.
      expect(socket.delivered()).toEqual([mine]);
      const types = socket.frames.map((frame) => frame.type);
      expect(types.indexOf("invalidate")).toBeLessThan(types.indexOf("hello"));
      publishTags([theirs]);
      publishTags([mine]);
      await until(() => socket.delivered().length === 2);
      await Bun.sleep(30);
      expect(socket.delivered()).toEqual([mine, mine]);
      socket.ws.close();
    } finally {
      await app.close();
    }
  });

  it("refuses a tag whose check throws or rejects, and logs it", async () => {
    const run = fresh();
    const thrown = `thrown:${run}`;
    const rejected = `rejected:${run}`;
    const fine = `fine:${run}`;
    const app = await serve((tag) => {
      if (tag === thrown) throw new Error("the check broke");
      if (tag === rejected) return Promise.reject(new Error("no answer"));
      return tag === fine;
    });
    try {
      const socket = await socketOf(app.ws);
      const hello = await socket.request("subscribe", {
        tags: [thrown, rejected, fine],
      });
      expect(hello.data!.denied).toEqual([thrown, rejected]);
      publishTags([thrown, rejected, fine]);
      await until(() => socket.delivered().length === 1);
      await Bun.sleep(30);
      expect(socket.delivered()).toEqual([fine]);
      expect(
        app.events.filter(
          (event) =>
            event.level === "error" &&
            event.message.includes("authorizeTag failed"),
        ).length,
      ).toBe(2);
      socket.ws.close();
    } finally {
      await app.close();
    }
  });

  it("does not ask again about a tag the socket holds", async () => {
    const run = fresh();
    const tag = `held:${run}`;
    const asked: string[] = [];
    const app = await serve((each) => {
      asked.push(each);
      return true;
    });
    try {
      const socket = await socketOf(app.ws);
      await socket.request("subscribe", { tags: [tag, tag] });
      await socket.request("subscribe", { tags: [tag] });
      expect(asked).toEqual([tag]);
      socket.ws.close();
    } finally {
      await app.close();
    }
  });
});

describe("authorizeTag on the SSE fallback", () => {
  it("streams only the allowed tags, lists the refused in hello, and never replays them", async () => {
    const run = fresh();
    const mine = `tenant:${run}`;
    const theirs = `tenant:other-${run}`;
    const app = await serve(byTenant);
    try {
      const query = `tenant=${run}&tag=${encodeURIComponent(mine)}&tag=${encodeURIComponent(theirs)}`;
      const controller = new AbortController();
      const first = readEvents(
        await fetch(`${app.http}/__live/sse?${query}`, {
          signal: controller.signal,
        }),
      );
      await until(() => first.list.length === 1);
      expect(first.list[0]!.event).toBe("hello");
      expect(first.list[0]!.data.denied).toEqual([theirs]);
      const helloId = first.list[0]!.id;
      publishTags([theirs]);
      publishTags([mine, theirs]);
      await until(() => first.list.length === 2);
      await Bun.sleep(30);
      expect(first.list.slice(1).map((e) => e.data.tags)).toEqual([[mine]]);
      controller.abort();

      // Resumed from the first hello: only the allowed tag is replayed.
      const resumed = new AbortController();
      const second = readEvents(
        await fetch(`${app.http}/__live/sse?${query}`, {
          signal: resumed.signal,
          headers: { "last-event-id": helloId },
        }),
      );
      await until(() => second.list.length === 2);
      await Bun.sleep(30);
      expect(second.list.map((e) => e.event)).toEqual(["invalidate", "hello"]);
      expect(second.list[0]!.data.tags).toEqual([mine]);
      resumed.abort();
    } finally {
      await app.close();
    }
  });

  it("answers 403 problem+json when every tag is refused, for a sync and an async hook, and opens no stream", async () => {
    const run = fresh();
    const theirs = `tenant:other-${run}`;
    const alsoTheirs = `tenant:third-${run}`;
    for (const hook of [
      byTenant,
      async (tag: string, req: Parameters<AuthorizeTag>[1]) =>
        byTenant(tag, req),
    ]) {
      const app = await serve(hook);
      try {
        const response = await fetch(
          `${app.http}/__live/sse?tenant=${run}&tag=${encodeURIComponent(theirs)}&tag=${encodeURIComponent(alsoTheirs)}`,
        );
        expect(response.status).toBe(403);
        expect(response.headers.get("content-type")).toBe(
          "application/problem+json",
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({
          type: "urn:bun-common:error:LIVE_TAGS_DENIED",
          title: "Forbidden",
          status: 403,
          code: "LIVE_TAGS_DENIED",
          detail: "None of the requested tags may be watched.",
          denied: [theirs, alsoTheirs],
        });
        // The control: one allowed tag among them opens the stream (200).
        const controller = new AbortController();
        const partial = await fetch(
          `${app.http}/__live/sse?tenant=${run}&tag=${encodeURIComponent(theirs)}&tag=tenant:${run}`,
          { signal: controller.signal },
        );
        expect(partial.status).toBe(200);
        const events = readEvents(partial);
        await until(() => events.list.length === 1);
        expect(events.list[0]!.data.denied).toEqual([theirs]);
        controller.abort();
      } finally {
        await app.close();
      }
    }
  });

  it("keeps a socket open when a subscribe's every tag is refused (the channel's analogue is the hello)", async () => {
    const run = fresh();
    const mine = `tenant:${run}`;
    const theirs = `tenant:other-${run}`;
    const app = await serve(byTenant);
    try {
      const socket = await socketOf(`${app.ws}?tenant=${run}`);
      const refused = await socket.request("subscribe", { tags: [theirs] });
      expect(refused.type).toBe("hello");
      expect(refused.data!.denied).toEqual([theirs]);
      expect(socket.ws.readyState).toBe(WebSocket.OPEN);
      // Still usable: a later subscribe of an allowed tag is served.
      const allowed = await socket.request("subscribe", { tags: [mine] });
      expect(allowed.data!.denied).toBeUndefined();
      publishTags([mine, theirs]);
      await until(() => socket.delivered().length === 1);
      await Bun.sleep(30);
      expect(socket.delivered()).toEqual([mine]);
      socket.ws.close();
    } finally {
      await app.close();
    }
  });
});

describe("the option and the contract", () => {
  it("refuses an authorizeTag that is not a function", () => {
    const app = new BunHttpAdapter(0);
    expect(() =>
      liveInvalidation(app, {
        authorize: (_req, _res, next) => next(),
        authorizeTag: true as unknown as AuthorizeTag,
      }),
    ).toThrow(ConfigError);
  });

  it("declares hello's denied: tags, optional", () => {
    const hello = liveContract.spec.sends.hello["~standard"];
    const ok = { epoch: "e", seq: 1 };
    expect(hello.validate(ok)).toEqual({ value: ok });
    const withDenied = { epoch: "e", seq: 1, denied: ["tenant:7"] };
    expect(hello.validate(withDenied)).toEqual({ value: withDenied });
    const bad = hello.validate({ epoch: "e", seq: 1, denied: [""] });
    expect("issues" in bad && bad.issues?.[0]?.path).toEqual(["denied", 0]);
    const json = hello.jsonSchema.output() as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(json.properties)).toContain("denied");
    expect(json.required).toEqual(["epoch", "seq"]);
  });
});
