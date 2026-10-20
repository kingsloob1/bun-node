/**
 * The WebSocket differential (NestJS 12 parity plan, §9.2 item 3): the same
 * gateways booted on `@nestjs/platform-ws`'s `WsAdapter` and on bun-nest's
 * `BunWebSocketAdapter`, on whichever Nest major is installed, sent the same
 * messages, and compared on **semantics, not frames**: which handler ran, the
 * reply and the ack, whether an exception reaches the client and with what
 * payload, the disconnect reason, request-scoped instances, hook errors, and
 * 12.2.0's flow control (the concurrency bound, nestjs/nest 0bd0810ed;
 * backpressure, db4e586c5). platform-ws's answer is the expectation,
 * measured, not assumed, so this test moves with Nest.
 *
 * It guards the Q4 (a) patch of `BaseWsExceptionFilter.prototype.emitMessage`
 * (`routeWsExceptionsThroughEmit`) on every matrix column: our side reads
 * only our own packets, so if the patch stops applying, Nest 12's
 * `{ event, data }` frame reads as `raw` and every exception case fails.
 *
 * Two kinds of entries are not plain comparisons:
 *
 * - `KNOWN`: differences by design (socket.io-shaped acks), each still
 *   checked to differ, so a change that removes one fails until it goes.
 * - `REFERENCE_CATCHES_RESULT_ERRORS`: on a platform-ws that leaves an
 *   errored result stream uncaught (11.1.20, 12.0.0), the cases that error
 *   one are `KNOWN` rows of their own, which capture the uncaught error.
 * - `since122`: behaviour platform-ws gained in 12.2.0. Where the installed
 *   platform-ws has it (`referenceHasFlowControl()`), ours is compared with
 *   it; on an older one, with the answer 12.2.0 gave, recorded.
 *
 * The deep-payload case makes `JSON.stringify` overflow, which costs about
 * 1.5 s of CPU per attempt in Bun (oven-sh/bun#45791), so it waits on a
 * sentinel reply with a generous deadline that only reports a hang.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { Booted, Client, Frame, Side } from "./wsCompat/harness";
import { BaseWsExceptionFilter } from "@nestjs/websockets";
import { WebSocketsController } from "@nestjs/websockets/web-sockets-controller.js";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  AsyncRejectingGateway,
  ClosingGateway,
  ConnectionState,
  FlowGateway,
  Gate,
  MainGateway,
  ScopedGateway,
  Session,
  SessionGateway,
  SyncRejectingGateway,
} from "./wsCompat/gateways";
import {
  boot,
  captureUnhandled,
  connect,
  connectRaw,
  referenceCatchesResultErrors,
  referenceHasFlowControl,
  SIDES,
  until,
} from "./wsCompat/harness";
import "reflect-metadata";

/** A deadline for a step that is only slow, never stuck: CPU-bound work under load. */
const SLOW_MS = 60_000;

/**
 * Whether the installed `@nestjs/websockets` builds a gateway's exception
 * filters in the context of the connection when a connection hook fails
 * (12.2.0; before it, a request-scoped filter there is built without its
 * dependencies and throws, on every adapter). Core behaviour: read off the
 * controller, a capability.
 */
const CORE_SCOPES_HOOK_FILTERS = hasControllerMethod("logResolutionError");

/**
 * Whether connection-hook errors reach the gateway's exception filters
 * (12.0, nestjs/nest #18048). Before it, on Nest 11, they are rethrown as
 * unhandled rxjs errors on both sides, so there is nothing to compare.
 */
const CORE_HOOK_ERRORS_TO_FILTERS = hasControllerMethod(
  "handleLifecycleHookError",
);

/** Whether gateways may be request-scoped, `REQUEST` being the client (12.0, 5e3dc4d0a). */
const CORE_REQUEST_SCOPED_GATEWAYS = hasControllerMethod(
  "createRequestScopedHandler",
);

/**
 * Whether Nest's default exception handling reaches a native socket at all
 * (12.0, nestjs/nest #16366: `emitMessage` sends to anything with a numeric
 * `readyState` and a `send`). On Nest 11 it calls `client.emit`, which on a
 * `ws` socket only dispatches locally: platform-ws's clients never receive an
 * exception, while ours, whose `emit` sends, do.
 */
const CORE_SENDS_EXCEPTIONS_TO_NATIVE =
  typeof (BaseWsExceptionFilter.prototype as unknown as Record<string, unknown>)
    .emitMessage === "function";

/**
 * Whether Nest's exception filter sends an exception again without its
 * `cause` when the first send throws (12.2.0, `emitErrorPayload`).
 */
const CORE_RETRIES_WITHOUT_CAUSE =
  typeof (BaseWsExceptionFilter.prototype as unknown as Record<string, unknown>)
    .emitErrorPayload === "function";

/**
 * Whether platform-ws catches and logs an errored result stream, keeping the
 * connection answered (11.2.7, 12.1.3); before it the error is uncaught, an
 * RxJS rethrow from a timer. Measured on a probe adapter.
 */
const REFERENCE_CATCHES_RESULT_ERRORS = referenceCatchesResultErrors();

/** Whether the installed `WebSocketsController` has `name`: a capability, never a version. */
function hasControllerMethod(name: string): boolean {
  return (
    typeof (
      WebSocketsController.prototype as unknown as Record<string, unknown>
    )[name] === "function"
  );
}

/** One comparison: what `observe` sees on each side. */
interface Case {
  /** The test's name. */
  name: string;
  /** The gateway path it connects to. */
  path: string;
  /** Drives one client and returns what was observed (plain data). */
  observe: (client: Client, booted: Booted) => Promise<unknown>;
  /** Why the two differ by design; the case then asserts that they still do. */
  known?: string;
  /** What 12.2.0's platform-ws answered, for a reference that predates it. */
  since122?: unknown;
  /** A per-case deadline, for the CPU-bound one. */
  timeout?: number;
  /** `false` skips the case (visibly): the installed Nest lacks what it needs, on both sides. */
  when?: boolean;
}

/** A frame without the side's `kind` noise: an event as `[event, data]`. */
function show(frame: Frame): unknown {
  return frame.kind === "event" ? [frame.event, frame.data] : frame;
}

/** Sends `push "sentinel"` and answers every frame received before its reply. */
async function untilSentinel(client: Client, ms = 5000): Promise<unknown[]> {
  client.send("push", "sentinel");
  const sentinel = await client.waitFor(
    (f) => f.kind === "event" && f.event === "pop" && f.data === "sentinel",
    ms,
  );
  return client.frames.slice(0, client.frames.indexOf(sentinel)).map(show);
}

/** The first `exception` event. */
async function exception(client: Client, ms = 5000): Promise<unknown> {
  const frame = await client.waitFor(
    (f) => (f.kind === "event" && f.event === "exception") || f.kind === "raw",
    ms,
  );
  return show(frame);
}

/** The reply to a plain (non-`WsResponse`) value: platform-ws's raw frame, our ack. */
async function plainReply(
  client: Client,
  booted: Booted,
  data: unknown,
): Promise<unknown> {
  client.send("value", data, booted.side === "bun" ? 1 : undefined);
  const frame = await client.waitFor(
    (f) => f.kind === "raw" || f.kind === "ack",
  );
  return frame.kind === "ack" ? frame.data[0] : frame.data;
}

/** An error as one line: `Name: message`. */
function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/**
 * For a platform-ws that leaves an errored result stream uncaught: sends what
 * errors it (`send`) and returns the errors RxJS reported unhandled, captured
 * rather than rethrown, and on our side what came back before the sentinel.
 * The reference's connection answers nothing more after the error, so its
 * side waits for the uncaught error instead of a sentinel.
 */
async function uncaught(
  client: Client,
  booted: Booted,
  send: () => void,
  ms = 5000,
): Promise<unknown> {
  const capture = captureUnhandled();
  try {
    send();
    if (booted.side === "ws") {
      const seen = await until(
        () => capture.seen,
        (errors) => errors.length > 0,
        ms,
        "the uncaught error",
      );
      return { uncaught: seen.map(describeError) };
    }
    const before = await untilSentinel(client, ms);
    return { uncaught: capture.seen.map(describeError), before };
  } finally {
    capture.restore();
  }
}

/** A JSON array nested `depth` deep: `JSON.parse` reads it, `JSON.stringify` overflows on it. */
function deepJson(depth: number): string {
  return `${"[".repeat(depth)}${"]".repeat(depth)}`;
}

const CASES: Case[] = [
  {
    name: "a WsResponse is the reply, from the handler that ran",
    path: "/main",
    observe: async (client, booted) => {
      client.send("push", { test: "test" });
      const reply = await client.waitFor((f) => f.kind === "event");
      return { reply: show(reply), ran: booted.trail.tagged("ran") };
    },
  },
  {
    name: "a plain value is the reply (platform-ws) or the ack (ours)",
    path: "/main",
    observe: async (client, booted) => ({
      reply: await plainReply(client, booted, 7),
    }),
  },
  {
    name: "a plain value without an ack id",
    path: "/main",
    known:
      "acks follow @nestjs/platform-socket.io: a plain value is sent only as the ack of a packet that asked for one",
    observe: async (client) => {
      client.send("value", 7);
      return { before: await untilSentinel(client) };
    },
  },
  {
    name: "a Promise of a reply",
    path: "/main",
    observe: async (client) => {
      client.send("later", "soon");
      return show(
        await client.waitFor((f) => f.kind === "event" && f.event === "later"),
      );
    },
  },
  {
    name: "an Observable's replies, in order",
    path: "/main",
    observe: async (client) => {
      client.send("stream", null);
      await until(
        () => client.frames.length,
        (n) => n >= 3,
        5000,
        "three replies",
      );
      return client.frames.map(show);
    },
  },
  {
    name: "a handler's Observable still running is unsubscribed when the client goes",
    path: "/main",
    observe: async (client, booted) => {
      client.send("forever", null);
      await client.waitFor((f) => f.kind === "event" && f.event === "tick");
      await client.close();
      await until(
        () => booted.trail.tagged("finalized"),
        (entries) => entries.length > 0,
        5000,
        "the Observable finalized",
      );
      return { finalized: booted.trail.tagged("finalized").length };
    },
  },
  {
    name: "a handler returning nothing sends nothing",
    path: "/main",
    observe: async (client, booted) => {
      client.send("quiet", null);
      return {
        before: await untilSentinel(client),
        ran: booted.trail.tagged("ran"),
      };
    },
  },
  {
    name: "an unknown event runs nothing and sends nothing",
    path: "/main",
    observe: async (client, booted) => {
      client.send("no-such-event", { x: 1 });
      return {
        before: await untilSentinel(client),
        ran: booted.trail.tagged("ran"),
      };
    },
  },
  {
    name: "@MessageBody(key) picks a property",
    path: "/main",
    observe: async (client) => {
      client.send("key", { k: 5 });
      return show(await client.waitFor((f) => f.kind === "event"));
    },
  },
  {
    name: "a thrown WsException reaches the client, with its cause",
    path: "/main",
    when: CORE_SENDS_EXCEPTIONS_TO_NATIVE,
    observe: async (client) => {
      client.send("fail", { x: 1 });
      return exception(client);
    },
  },
  {
    name: "an Observable erroring with a WsException (ws-error-gateway)",
    path: "/main",
    when: CORE_SENDS_EXCEPTIONS_TO_NATIVE,
    observe: async (client) => {
      client.send("failLater", { test: "test" });
      return exception(client);
    },
  },
  {
    name: "a WsException with an object is sent as that object",
    path: "/main",
    when: CORE_SENDS_EXCEPTIONS_TO_NATIVE,
    observe: async (client) => {
      client.send("failObject", null);
      return exception(client);
    },
  },
  {
    name: "an unknown error is 'Internal server error', and logged",
    path: "/main",
    when: CORE_SENDS_EXCEPTIONS_TO_NATIVE,
    observe: async (client, booted) => {
      const before = booted.logs.length;
      client.send("boom", { y: 2 });
      const sent = await exception(client);
      await until(
        () => booted.logs.slice(before),
        (lines) => lines.some((line) => line.message === "secret detail"),
        5000,
        "the error logged",
      );
      return {
        sent,
        logged: booted.logs
          .slice(before)
          .filter((line) => line.message === "secret detail")
          .map((line) => line.level),
      };
    },
  },
  {
    name: "Nest 11: platform-ws never delivers a WsException (#16366); ours does, through emit",
    path: "/main",
    when: !CORE_SENDS_EXCEPTIONS_TO_NATIVE,
    known:
      "on Nest 11, platform-ws's clients get no exception at all (fixed in 12.0); ours get it as with socket.io",
    observe: async (client, booted) => {
      client.send("fail", { x: 1 });
      if (booted.side === "bun") {
        return { delivered: await exception(client) };
      }
      // Nothing is ever sent on this side, so no ordering is at stake.
      return { delivered: (await untilSentinel(client))[0] ?? null };
    },
  },
  {
    name: "an interceptor reads the pattern",
    path: "/main",
    observe: async (client) => {
      client.send("getClient", { test: "test" });
      return show(await client.waitFor((f) => f.kind === "event"));
    },
  },
  {
    name: "a filter reads the pattern",
    path: "/main",
    observe: async (client) => {
      client.send("getClientWithError", { test: "test" });
      return exception(client);
    },
  },
  {
    name: "a filter that throws",
    path: "/main",
    when: REFERENCE_CATCHES_RESULT_ERRORS,
    known:
      "ours answers an errored result stream with an ERROR packet; platform-ws logs it and sends nothing",
    observe: async (client, booted) => {
      const before = booted.logs.length;
      client.send("rethrow", null);
      const frames = await untilSentinel(client);
      return {
        before: frames,
        logged: booted.logs
          .slice(before)
          .some((line) => line.message === "the filter threw"),
      };
    },
  },
  {
    name: "a filter that throws, on a platform-ws that leaves it uncaught",
    path: "/main",
    when: !REFERENCE_CATCHES_RESULT_ERRORS,
    known:
      "ours answers an errored result stream with an ERROR packet; this platform-ws leaves the error uncaught, which RxJS rethrows",
    observe: async (client, booted) =>
      uncaught(client, booted, () => client.send("rethrow", null)),
  },
  {
    name: "a WsException whose cause cannot be serialised",
    path: "/main",
    // Where Nest 11 only emits it locally, nothing is serialised; otherwise
    // the reference must catch the failed send for an answer to compare.
    when: !CORE_SENDS_EXCEPTIONS_TO_NATIVE || REFERENCE_CATCHES_RESULT_ERRORS,
    // Before 12.2.0's retry without the cause, the failed send errors the
    // result stream: ours answers that with an ERROR packet, platform-ws
    // logs it.
    known:
      CORE_SENDS_EXCEPTIONS_TO_NATIVE && !CORE_RETRIES_WITHOUT_CAUSE
        ? "before 12.2.0 the unsendable exception errors the stream: an ERROR packet on ours, a log line on platform-ws"
        : undefined,
    timeout: SLOW_MS * 2,
    observe: async (client) => {
      client.sendJson("deep", deepJson(200_000));
      return { before: await untilSentinel(client, SLOW_MS) };
    },
  },
  {
    name: "a WsException whose cause cannot be serialised, on a platform-ws that leaves it uncaught",
    path: "/main",
    when: CORE_SENDS_EXCEPTIONS_TO_NATIVE && !REFERENCE_CATCHES_RESULT_ERRORS,
    known:
      "the unsendable exception errors the stream: an ERROR packet on ours; this platform-ws leaves the RangeError uncaught, which RxJS rethrows",
    timeout: SLOW_MS * 2,
    observe: async (client, booted) =>
      uncaught(
        client,
        booted,
        () => client.sendJson("deep", deepJson(200_000)),
        SLOW_MS,
      ),
  },
  {
    name: "handleDisconnect gets the close code as its reason",
    path: "/main",
    observe: async (client, booted) => {
      await client.close(4001, "bye");
      const [entry] = await until(
        () => booted.trail.tagged("disconnect"),
        (entries) => entries.length > 0,
        5000,
        "handleDisconnect",
      );
      return entry;
    },
  },
  {
    name: "a server-side close: the client's close event and the hook's reason",
    path: "/main",
    observe: async (client, booted) => {
      client.send("kick", null);
      const closed = await client.closed;
      const [entry] = await until(
        () => booted.trail.tagged("disconnect"),
        (entries) => entries.length > 0,
        5000,
        "handleDisconnect",
      );
      return { closed, entry };
    },
  },
  {
    name: "handleConnection throwing: the exception is sent, the client stays (connection-hook-error)",
    path: "/hook-sync",
    when: CORE_HOOK_ERRORS_TO_FILTERS,
    observe: async (client) => {
      const first = await exception(client);
      client.send("push", "still here");
      return {
        first,
        after: show(
          await client.waitFor((f) => f.kind === "event" && f.event === "pop"),
        ),
      };
    },
  },
  {
    name: "handleConnection rejecting: the same",
    path: "/hook-async",
    when: CORE_HOOK_ERRORS_TO_FILTERS,
    observe: async (client) => {
      const first = await exception(client);
      client.send("push", "still here");
      return {
        first,
        after: show(
          await client.waitFor((f) => f.kind === "event" && f.event === "pop"),
        ),
      };
    },
  },
  {
    name: "what a client sent after handleConnection closed it is not handled",
    path: "/closing",
    since122: { closed: { code: 4000, reason: "go away" }, ran: [] },
    observe: async (client, booted) => {
      client.send("push", null);
      const closed = await client.closed;
      return { closed, ran: booted.trail.tagged("ran") };
    },
  },
  {
    name: "a request-scoped filter closes the connection it was built for (12.2.0 scoped-connection-hook-error)",
    path: "/session",
    when: CORE_SCOPES_HOOK_FILTERS,
    observe: async (client) => ({ closed: await client.closed }),
  },
];

/** Both sides, booted once with every gateway above. */
const booted = {} as Record<Side, Booted>;

beforeAll(async () => {
  for (const side of SIDES) {
    booted[side] = await boot(
      side,
      [
        MainGateway,
        SyncRejectingGateway,
        AsyncRejectingGateway,
        ClosingGateway,
        ScopedGateway,
        SessionGateway,
      ],
      { providers: [ConnectionState, Session] },
    );
  }
});

afterAll(async () => {
  for (const side of SIDES) {
    await booted[side]?.app.close();
  }
});

/** Runs `observe` on a fresh client of each side, with a fresh trail. */
async function observeBoth(entry: Case): Promise<Record<Side, unknown>> {
  const seen = {} as Record<Side, unknown>;
  for (const side of SIDES) {
    const b = booted[side];
    b.trail.entries.length = 0;
    const client = await connect(b, entry.path);
    try {
      seen[side] = await entry.observe(client, b);
    } finally {
      await client.close();
    }
  }
  return seen;
}

describe("WebSocket differential: platform-ws's WsAdapter vs BunWebSocketAdapter", () => {
  for (const entry of CASES) {
    it.skipIf(entry.when === false)(
      entry.name,
      async () => {
        const seen = await observeBoth(entry);
        if (entry.known) {
          // A difference by design that no longer differs comes off the list.
          expect(seen.bun).not.toEqual(seen.ws);
          return;
        }
        if (entry.since122 !== undefined && !referenceHasFlowControl()) {
          expect(seen.bun).toEqual(entry.since122);
          return;
        }
        expect(seen.bun).toEqual(seen.ws);
      },
      entry.timeout,
    );
  }

  it.skipIf(!CORE_REQUEST_SCOPED_GATEWAYS)(
    "request-scoped gateways: one instance per connection, REQUEST is the client (request-scope-gateway)",
    async () => {
      const seen = {} as Record<Side, unknown>;
      for (const side of SIDES) {
        const b = booted[side];
        b.trail.entries.length = 0;
        const a = await connect(b, "/scoped");
        const c = await connect(b, "/scoped");
        const event = (client: Client, name: string, nth = 0) =>
          until(
            () =>
              client.frames.filter(
                (f) => f.kind === "event" && f.event === name,
              ),
            (frames) => frames.length > nth,
            5000,
            name,
          ).then(
            (frames) => (frames[nth] as { data: Record<string, unknown> }).data,
          );
        const aConnected = await event(a, "connectedState");
        const cConnected = await event(c, "connectedState");
        a.send("state", null);
        const aState = await event(a, "state");
        c.send("state", null);
        const cState = await event(c, "state");
        await a.close(4001, "bye");
        const [disconnect] = await until(
          () => b.trail.tagged("scoped-disconnect"),
          (entries) => entries.length > 0,
          5000,
          "the scoped disconnect hook",
        );
        await c.close();
        const aId = aConnected.instanceId;
        // Instance ids count across both apps; compare them by identity.
        const ids = (value: Record<string, unknown>) => ({
          ...value,
          instanceId: value.instanceId === aId ? "a" : "other",
        });
        seen[side] = {
          aConnected: ids(aConnected),
          aState: ids(aState),
          cConnected: ids(cConnected),
          cState: ids(cState),
          sameInstanceForC: cConnected.instanceId === cState.instanceId,
          disconnect: ids((disconnect as [string, Record<string, unknown>])[1]),
        };
      }
      expect(seen.bun).toEqual(seen.ws);
    },
  );
});

describe("WebSocket differential: 12.2.0's concurrency bound (0bd0810ed)", () => {
  /** Boots both sides' flow gateway with `maxConcurrentMessages`. */
  async function bootFlow(maxConcurrentMessages?: number) {
    const sides = {} as Record<Side, Booted>;
    for (const side of SIDES) {
      sides[side] = await boot(side, [FlowGateway], {
        flow:
          maxConcurrentMessages === undefined
            ? undefined
            : { maxConcurrentMessages },
        providers: [Gate],
      });
    }
    return sides;
  }

  /**
   * Sends `holds` hold messages and a ping, then, while the holds are held,
   * reads how many started and whether the ping was answered; then releases
   * one, then all, and reads the replies.
   */
  async function observeBound(b: Booted, holds: number, bound: number) {
    const gate = b.app.get(Gate);
    const client = await connect(b, "/flow");
    try {
      for (let i = 1; i <= holds; i++) {
        client.send("hold", i);
      }
      client.send("ping", "p");
      const expectStarted = Math.min(bound, holds);
      await until(
        () => gate.started.length,
        (n) => n >= expectStarted,
        10_000,
        `${expectStarted} holds started`,
      );
      // Settled: whatever else would start has had its turn. A wait for an
      // absence, so it can only pass falsely under load, never fail falsely.
      await Bun.sleep(100);
      const whileHeld = {
        started: gate.started.length,
        pinged: client.frames.some(
          (f) => f.kind === "event" && f.event === "pong",
        ),
      };
      gate.release();
      const afterOne = await until(
        () => gate.started.length,
        (n) => n >= Math.min(expectStarted + 1, holds),
        10_000,
        "one more hold started",
      );
      gate.open();
      const done = await until(
        () => client.frames.filter((f) => f.kind === "event"),
        (frames) => frames.length >= holds + 1,
        10_000,
        "every reply",
      );
      const pongIndex = done.findIndex(
        (f) => f.kind === "event" && f.event === "pong",
      );
      return {
        whileHeld,
        startedAfterOneRelease: afterOne,
        order: gate.started,
        replies: done.length,
        pongAfterHolds: pongIndex,
      };
    } finally {
      gate.open();
      await client.close();
    }
  }

  for (const [label, bound, holds, since122] of [
    [
      "maxConcurrentMessages: 2",
      2,
      5,
      {
        whileHeld: { started: 2, pinged: false },
        startedAfterOneRelease: 3,
        order: [1, 2, 3, 4, 5],
        replies: 6,
        pongAfterHolds: 5,
      },
    ],
    [
      "the default, 1000",
      undefined,
      1001,
      {
        whileHeld: { started: 1000, pinged: false },
        startedAfterOneRelease: 1001,
        order: Array.from({ length: 1001 }, (_, i) => i + 1),
        replies: 1002,
        pongAfterHolds: 1001,
      },
    ],
  ] as const) {
    it(`${label}: later messages wait, in order, for a slot`, async () => {
      const sides = await bootFlow(bound);
      try {
        const limit = bound ?? 1000;
        const bun = await observeBound(sides.bun, holds, limit);
        if (!referenceHasFlowControl()) {
          expect(bun as unknown).toEqual(since122);
          return;
        }
        const ws = await observeBound(sides.ws, holds, limit);
        expect(bun).toEqual(ws);
      } finally {
        for (const side of SIDES) await sides[side].app.close();
      }
    });
  }

  it("maxConcurrentMessages: Infinity lifts it", async () => {
    const sides = await bootFlow(Infinity);
    try {
      const seen = {} as Record<Side, unknown>;
      for (const side of SIDES) {
        const b = sides[side];
        const gate = b.app.get(Gate);
        const client = await connect(b, "/flow");
        for (let i = 1; i <= 50; i++) client.send("hold", i);
        client.send("ping", "p");
        await client.waitFor((f) => f.kind === "event" && f.event === "pong");
        seen[side] = { startedBeforePong: gate.started.length };
        gate.open();
        await client.close();
      }
      expect(seen.bun).toEqual(seen.ws);
    } finally {
      for (const side of SIDES) await sides[side].app.close();
    }
  });
});

describe("WebSocket differential: 12.2.0's backpressure (db4e586c5)", () => {
  /** Each large reply's payload. */
  const SIZE = 256 * 1024;
  /**
   * How many large replies are asked for: 64 MB, well past what the kernel
   * buffers on loopback before the server's own queue grows (its receive
   * buffer autotunes up to 32 MB here) and the 1 MB at which reading pauses.
   */
  const COUNT = 256;

  /** How many of `lines` are the over-the-cap warning, for a 4 MB cap. */
  function warnings(lines: { level: string; message: string }[]): number {
    return lines.filter(
      (line) =>
        line.level === "warn" &&
        line.message.includes('"maxSendBufferSize" (4194304)'),
    ).length;
  }

  /** Waits until `read()` has not changed for `quietMs`; answers its value. */
  async function settled(read: () => number, quietMs = 150, ms = 20_000) {
    const end = Date.now() + ms;
    let last = read();
    let since = Date.now();
    while (Date.now() - since < quietMs) {
      if (Date.now() > end) {
        throw new Error(`still changing after ${ms} ms: ${last}`);
      }
      await Bun.sleep(20);
      const now = read();
      if (now !== last) {
        last = now;
        since = Date.now();
      }
    }
    return last;
  }

  it(
    "a client that does not read is read from no more, and loses nothing once it reads",
    async () => {
      const seen = {} as Record<Side, unknown>;
      const sides = SIDES.filter(
        (side) => side === "bun" || referenceHasFlowControl(),
      );
      for (const side of sides) {
        const b = await boot(side, [FlowGateway], { providers: [Gate] });
        try {
          const gate = b.app.get(Gate);
          const raw = await connectRaw(b.port, "/flow");
          raw.pause();
          const frame = (id: number) =>
            b.wire.encode("big", { id, size: SIZE });
          // One message at a time, each once the last was handled, so each
          // arrives in a read of its own: pausing stops the next read, not the
          // messages of one already made (Bun and ws both hand those over). The
          // first message the server does not handle within the quiet window
          // is where it stopped reading.
          let sent = 0;
          while (sent < COUNT) {
            sent += 1;
            raw.sendText(frame(sent));
            const handled = await settled(() => gate.started.length);
            if (handled < sent) {
              break;
            }
          }
          const handledWhileUnread = gate.started.length;
          // The rest in one go, then read: everything must arrive, in order.
          const rest: string[] = [];
          for (let id = sent + 1; id <= COUNT; id++) {
            rest.push(frame(id));
          }
          raw.sendTexts(rest);
          raw.resume();
          await until(
            () => raw.texts.length,
            (n) => n >= COUNT,
            SLOW_MS,
            "every reply",
          );
          const ids = raw.texts.map((text) => {
            const decoded = b.wire.decode(text);
            return decoded.kind === "event"
              ? (decoded.data as { id: number }).id
              : -1;
          });
          seen[side] = {
            stalled: handledWhileUnread < COUNT,
            delivered: ids.length,
            inOrder: ids.every((id, index) => id === index + 1),
            ended: raw.isEnded(),
          };
          raw.destroy();
        } finally {
          await b.app.close();
        }
      }
      const expected = referenceHasFlowControl()
        ? seen.ws
        : { stalled: true, delivered: COUNT, inOrder: true, ended: false };
      expect(seen.bun).toEqual(expected);
    },
    SLOW_MS * 2,
  );

  it(
    "more than maxSendBufferSize queued for a client disconnects it, with a warning",
    async () => {
      const seen = {} as Record<Side, unknown>;
      const sides = SIDES.filter(
        (side) => side === "bun" || referenceHasFlowControl(),
      );
      for (const side of sides) {
        const b = await boot(side, [FlowGateway], {
          flow: { maxSendBufferSize: 4 * 1024 * 1024 },
          providers: [Gate],
        });
        try {
          const before = b.logs.length;
          const raw = await connectRaw(b.port, "/flow");
          raw.pause();
          raw.sendText(
            b.wire.encode("flood", { count: COUNT * 2, size: SIZE }),
          );
          // The server side's view: a paused client may not read the close.
          await until(
            () => b.trail.tagged("flow-disconnect").length,
            (n) => n > 0,
            SLOW_MS,
            `${side}: the client disconnected`,
          );
          seen[side] = {
            disconnected: b.trail.tagged("flow-disconnect").length,
            warned: warnings(b.logs.slice(before)),
          };
          raw.destroy();
        } finally {
          await b.app.close();
        }
      }
      const expected = referenceHasFlowControl()
        ? seen.ws
        : { disconnected: 1, warned: 1 };
      expect(seen.bun).toEqual(expected);
    },
    SLOW_MS * 2,
  );
});
