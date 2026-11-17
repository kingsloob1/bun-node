/**
 * Event batches at the control plane (README §8.5, control-plane.md §9): a
 * posted body decoded within its bounds (1 MiB as sent, 8 MiB unpacked, a
 * gzip bomb stopped), a batch stored once with its counters, another
 * service's refused, and `POST /agent/events` on the management API:
 * authenticated before its body is read, rate limited per agent.
 */
import type { AgentEventBatch } from "../../lib/analytics/index";
import type { AgentIdentity } from "../../lib/control/index";
import { gzipSync } from "node:zlib";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import {
  decodeEventBatch,
  EVENT_BATCH_FORMAT,
  EventBatchError,
  ingestEventBatch,
} from "../../lib/analytics/index";
import { memoryStore } from "../../lib/store/index";
import { testApi } from "../control/helpers";

const T0 = Date.UTC(2026, 10, 17, 12);

/** A batch of `api`'s. */
function batch(overrides: Partial<AgentEventBatch> = {}): AgentEventBatch {
  return {
    format: EVENT_BATCH_FORMAT,
    batchId: "b1",
    service: "api",
    sentAt: T0,
    events: [
      {
        id: "e1",
        at: T0,
        service: "api",
        action: "block",
        rule: "r1",
        subjects: { ip: "203.0.113.7" },
      },
    ],
    counters: [
      {
        service: "api",
        at: T0,
        metric: "requests",
        dims: { action: "block" },
        value: 3,
      },
    ],
    ...overrides,
  };
}

/** What `run` threw, as an {@link EventBatchError}'s status. */
async function status(run: () => unknown): Promise<number | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    if (error instanceof EventBatchError) return error.status;
    throw error;
  }
}

const bytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

describe("decodeEventBatch", () => {
  it("reads JSON as sent or gzipped", () => {
    expect(decodeEventBatch(bytes(batch()), null)).toEqual(batch());
    expect(decodeEventBatch(gzipSync(bytes(batch())), "gzip")).toEqual(batch());
  });

  it("refuses past 1 MiB as sent, a gzip bomb past 8 MiB, an unknown encoding, and non-JSON", async () => {
    expect(
      await status(() =>
        decodeEventBatch(new Uint8Array(1024 * 1024 + 1), null),
      ),
    ).toBe(413);
    const bomb = gzipSync(new Uint8Array(20 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    expect(await status(() => decodeEventBatch(bomb, "gzip"))).toBe(413);
    // The control: under the bound, the same kind of body unpacks.
    expect(
      await status(() =>
        decodeEventBatch(
          gzipSync(bytes({ pad: "0".repeat(1_000_000) })),
          "gzip",
        ),
      ),
    ).toBeUndefined();
    expect(await status(() => decodeEventBatch(bytes(batch()), "br"))).toBe(
      415,
    );
    expect(
      await status(() =>
        decodeEventBatch(new TextEncoder().encode("{nope"), null),
      ),
    ).toBe(400);
    expect(
      await status(() => decodeEventBatch(new Uint8Array([1, 2, 3]), "gzip")),
    ).toBe(400);
  });
});

describe("ingestEventBatch", () => {
  it("stores a batch once: a resend writes no event and adds no counter", async () => {
    const store = memoryStore();
    expect(await ingestEventBatch(store, batch(), { service: "api" })).toEqual({
      duplicate: false,
    });
    expect(await ingestEventBatch(store, batch(), { service: "api" })).toEqual({
      duplicate: true,
    });
    expect(
      (await store.listEvents!({ limit: 10 })).items.map((e) => e.id),
    ).toEqual(["e1"]);
    const [point] = await store.series!({
      metric: "requests",
      from: T0,
      to: T0 + 60_000,
    });
    expect(point?.value).toBe(3);
  });

  it("refuses another service's batch, event or counter, and malformed input, writing nothing", async () => {
    const store = memoryStore();
    const foreign = [
      batch({ service: "web" }),
      batch({ events: [{ ...batch().events[0]!, service: "web" }] }),
      batch({ counters: [{ ...batch().counters[0]!, service: "web" }] }),
    ];
    for (const input of foreign)
      expect(
        await status(() => ingestEventBatch(store, input, { service: "api" })),
      ).toBe(403);
    const malformed: unknown[] = [
      null,
      { ...batch(), format: "other" },
      { ...batch(), batchId: 1 },
      { ...batch(), events: "x" },
      batch({ events: [{ ...batch().events[0]!, at: -1 }] }),
      batch({ counters: [{ ...batch().counters[0]!, value: -1 }] }),
    ];
    for (const input of malformed)
      expect(
        await status(() => ingestEventBatch(store, input, { service: "api" })),
      ).toBe(400);
    const many = batch({
      events: Array.from({ length: 501 }, (_, i) => ({
        ...batch().events[0]!,
        id: `e${i}`,
      })),
    });
    expect(
      await status(() => ingestEventBatch(store, many, { service: "api" })),
    ).toBe(413);
    expect((await store.listEvents!({ limit: 10 })).items).toEqual([]);
    // The control: the batch id of a refused batch is still free.
    expect(await ingestEventBatch(store, batch(), { service: "api" })).toEqual({
      duplicate: false,
    });
  });
});

describe("POST /agent/events", () => {
  /** An API with agent `a1` of `api` named by an `x-agent` header; and how many bodies were read. */
  const setup = (rateLimit?: number, deferBody = true) => {
    const seen: string[] = [];
    const { api, store, clock } = testApi({
      agentEvents: {
        authenticate: (req): AgentIdentity | undefined => {
          seen.push("authenticate");
          return req.request.headers.get("x-agent") === "a1"
            ? { id: "a1", service: "api" }
            : undefined;
        },
        ...(rateLimit === undefined ? {} : { rateLimit }),
      },
    });
    // As secureAdmin builds it: bodies read on a route's first need.
    const app = new BunHttpAdapter(0, {
      logger: () => {},
      ...(deferBody ? { request: { deferBody: true } } : {}),
    });
    app.use(api.basePath, api.router);
    const post = async (
      body: Uint8Array | ReadableStream<Uint8Array> | null,
      headers: Record<string, string> = {},
    ) => {
      const response = await app.fetch(`${api.basePath}/agent/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "x-agent": "a1",
          ...headers,
        },
        body,
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
        headers: response.headers,
      };
    };
    return { post, store, clock, seen };
  };

  /** A body whose stream records being read. */
  const watched = (reads: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream(
      {
        pull(controller) {
          reads.push("read");
          controller.enqueue(gzipSync(bytes(batch())));
          controller.close();
        },
      },
      // Nothing pulled until a reader asks.
      { highWaterMark: 0 },
    );

  it("stores an authenticated agent's batch, once", async () => {
    const { post, store } = setup();
    expect(await post(gzipSync(bytes(batch())))).toMatchObject({
      status: 200,
      body: { duplicate: false },
    });
    expect(await post(gzipSync(bytes(batch())))).toMatchObject({
      status: 200,
      body: { duplicate: true },
    });
    expect((await store.listEvents!({ limit: 10 })).items).toHaveLength(1);
  });

  it("refuses an unauthenticated agent before its body stream is pulled (socket-free)", async () => {
    const { post } = setup();
    const reads: string[] = [];
    const answer = await post(watched(reads), { "x-agent": "nobody" });
    expect(answer.status).toBe(401);
    expect(answer.body.code).toBe("unauthenticated");
    expect(reads).toEqual([]);
    // The control: an authenticated one's body is read.
    const read: string[] = [];
    expect((await post(watched(read))).status).toBe(200);
    expect(read).toEqual(["read"]);
    // The negative control: an adapter that reads bodies before routing has
    // read it before any route could authenticate (why secureAdmin defers).
    const eager = setup(undefined, false);
    const early: string[] = [];
    expect(
      (await eager.post(watched(early), { "x-agent": "nobody" })).status,
    ).toBe(401);
    expect(early).toEqual(["read"]);
  });

  it("refuses a body declared over 1 MiB without reading it, and another service's batch", async () => {
    const { post } = setup();
    const reads: string[] = [];
    const answer = await post(watched(reads), {
      "content-length": String(2 * 1024 * 1024),
    });
    expect(answer.status).toBe(413);
    expect(answer.body.code).toBe("too_large");
    expect(reads).toEqual([]);
    // A streamed body with no length is cut at the bound, not read to its end.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(256 * 1024));
          if (pulled > 64) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    expect((await post(endless)).status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(6);
    expect(
      (await post(gzipSync(bytes(batch({ service: "web" }))))).status,
    ).toBe(403);
    expect(
      (await post(bytes(batch()), { "content-encoding": "br" })).status,
    ).toBe(415);
  });

  it("on an adapter that reads bodies before routing, takes the body it read", async () => {
    const { post, store } = setup(undefined, false);
    expect(await post(gzipSync(bytes(batch())))).toMatchObject({
      status: 200,
      body: { duplicate: false },
    });
    expect(
      await post(bytes(batch({ batchId: "b2" })), {
        "content-encoding": "identity",
      }),
    ).toMatchObject({
      status: 200,
    });
    expect((await store.listEvents!({ limit: 10 })).items).toHaveLength(1);
    expect(
      (await post(gzipSync(bytes(batch({ batchId: "b3", service: "web" })))))
        .status,
    ).toBe(403);
  });

  it("limits each agent to rateLimit batches a second", async () => {
    const { post, clock } = setup(2);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push(
        (await post(gzipSync(bytes(batch({ batchId: `b${i}` }))))).status,
      );
    expect(statuses).toEqual([200, 200, 429]);
    const limited = await post(gzipSync(bytes(batch({ batchId: "b9" }))));
    expect(limited.headers.get("retry-after")).toBe("1");
    clock.advance(1_000);
    expect((await post(gzipSync(bytes(batch({ batchId: "b9" }))))).status).toBe(
      200,
    );
  });

  it("is absent without agentEvents, and refuses a store without analytics", () => {
    const { api } = testApi();
    expect(JSON.stringify(api.openapi())).not.toContain("/agent/events");
    expect(() =>
      testApi({
        store: { ...memoryStore(), appendEvents: undefined },
        agentEvents: { authenticate: () => undefined },
      }),
    ).toThrow(/needs a store with analytics/);
  });
});

describe("POST /agent/events on a real socket", () => {
  /** What the request's body looked like when `authenticate` ran, on an adapter that defers bodies or not. */
  const atAuthentication = async (deferBody: boolean) => {
    const seen: { used: boolean; locked: boolean | null }[] = [];
    const { api } = testApi({
      agentEvents: {
        authenticate: (req): AgentIdentity | undefined => {
          seen.push({
            used: req.request.bodyUsed,
            locked: req.request.body?.locked ?? null,
          });
          return undefined;
        },
      },
    });
    const app = new BunHttpAdapter(0, {
      logger: () => {},
      ...(deferBody ? { request: { deferBody: true } } : {}),
    });
    app.use(api.basePath, api.router);
    const server = await app.listen(0);
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}${api.basePath}/agent/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch()),
        },
      );
      return { status: response.status, seen };
    } finally {
      await app.close();
    }
  };

  it("with deferred bodies, authenticates while the body stream is still unread", async () => {
    expect(await atAuthentication(true)).toEqual({
      status: 401,
      seen: [{ used: false, locked: false }],
    });
  });

  it("negative control: an adapter that reads bodies first has read it before any route runs", async () => {
    expect((await atAuthentication(false)).seen).toEqual([
      { used: true, locked: true },
    ]);
  });
});
