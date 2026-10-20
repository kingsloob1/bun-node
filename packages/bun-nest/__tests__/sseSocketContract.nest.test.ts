/**
 * The request-socket contract NestJS's SSE support relies on, asserted
 * directly on bun-common's `BunRequest`/`BunResponse` as bun-nest hands them
 * to a controller.
 *
 * Why this exists: Nest's `RouterResponseController.sse()` (11 and 12) and
 * Nest 12's `fromClientDisconnect` learn that the client left from
 * `request.socket ?? response` emitting `close`, and Nest 12 also reads
 * `socket.destroyed` first, for a client that left before the handler ran.
 * That is how `@Sse()` streams are torn down and how `@SseSignal()` aborts.
 * Bun has no per-request socket: `req.socket` is a shim in bun-common whose
 * `close` and `destroyed` come from the request's abort signal. A change to
 * that shim (the planned SSE helpers, `bun-native-routes` PR-sse2 to sse5)
 * would break SSE teardown silently, since the `@SseSignal()` suite only runs
 * on Nest versions that have the decorator. This file is not gated: it runs
 * on every Nest, develop's lock included.
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import { Controller, Get, Module, Query, Req, Res } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import "reflect-metadata";

/** How long any one awaited event may take before the test fails, naming it. */
const DEADLINE_MS = 5000;

/** A test's own timeout: several deadlines, so a missing event fails with its name, not a bare timeout. */
const TEST_TIMEOUT_MS = 30_000;

/** What one request's handler was handed, and what its socket and response emitted. */
class Seen {
  /** The request bun-nest passed to the controller. */
  req: BunRequest | undefined;
  /** The response bun-nest passed to the controller. */
  res: BunResponse | undefined;
  /** `req.socket.destroyed` when the handler ran. */
  destroyedAtStart: boolean | undefined;
  /** What was emitted, in order: `socket close`, `response finish`, `response close`. */
  readonly emitted: string[] = [];
  /** Resolves when the handler has run. */
  readonly handled = Promise.withResolvers<void>();
  /** Resolves on the socket's `close`. */
  readonly socketClosed = Promise.withResolvers<void>();
  /** Resolves on the response's `close`. */
  readonly responseClosed = Promise.withResolvers<void>();
}

/** Every request's record, by the `k` query parameter. */
const seen = new Map<string, Seen>();

/** The record for key `k`, created on first use. */
function record(k: string): Seen {
  let found = seen.get(k);
  if (!found) {
    found = new Seen();
    seen.set(k, found);
  }
  return found;
}

/** Listens on the socket and the response the way Nest's SSE code does. */
function listen(s: Seen, req: BunRequest, res: BunResponse): void {
  s.req = req;
  s.res = res;
  s.destroyedAtStart = req.socket.destroyed;
  req.socket.once("close", () => {
    s.emitted.push("socket close");
    s.socketClosed.resolve();
  });
  res.once("finish", () => s.emitted.push("response finish"));
  res.once("close", () => {
    s.emitted.push("response close");
    s.responseClosed.resolve();
  });
}

@Controller("contract")
class ContractController {
  /** An open event stream: written to, never ended by the server. */
  @Get("open")
  open(
    @Query("k") k: string,
    @Req() req: BunRequest,
    @Res() res: BunResponse,
  ): void {
    const s = record(k);
    listen(s, req, res);
    res.setHeader("Content-Type", "text/event-stream");
    res.write("data: first\n\n");
    s.handled.resolve();
  }

  /** A response that completes at once. */
  @Get("done")
  done(
    @Query("k") k: string,
    @Req() req: BunRequest,
    @Res() res: BunResponse,
  ): void {
    const s = record(k);
    listen(s, req, res);
    res.send("done");
    s.handled.resolve();
  }

  /**
   * Never answers, and listens on the response only: the socket's emitter
   * is first touched after the client has gone, as when a guard delays
   * Nest 11's `sse()` past the disconnect.
   */
  @Get("held")
  held(
    @Query("k") k: string,
    @Req() req: BunRequest,
    @Res() res: BunResponse,
  ): void {
    const s = record(k);
    s.req = req;
    s.res = res;
    s.destroyedAtStart = req.socket.destroyed;
    res.once("close", () => s.responseClosed.resolve());
    s.handled.resolve();
  }
}

@Module({ controllers: [ContractController] })
class ContractModule {}

/** Awaits `pending` or throws, naming `what`, once {@link DEADLINE_MS} passes. */
async function within(pending: Promise<unknown>, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ok = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(resolve, DEADLINE_MS, false);
      }),
    ]);
    if (!ok) {
      throw new Error(`${what}: nothing within ${DEADLINE_MS} ms`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** How a test reaches the app. */
type Mode = "served" | "adapter.fetch()";

/** Sends a `GET` for `path` (with `signal`). */
type Send = (path: string, signal?: AbortSignal) => Promise<Response>;

/** Applications to close after the suite. */
const apps: INestApplication[] = [];

/** One sender per mode, set by `beforeAll`. */
const send = {} as Record<Mode, Send>;

beforeAll(async () => {
  const served = await NestFactory.create(
    ContractModule,
    new BunHttpAdapter(0),
    { logger: false },
  );
  apps.push(served);
  await served.listen(0, "127.0.0.1");
  const url = await served.getUrl();

  const adapter = new BunHttpAdapter();
  const fetched = await NestFactory.create(ContractModule, adapter, {
    logger: false,
  });
  apps.push(fetched);
  await fetched.init();

  send.served = async (path, signal) => fetch(`${url}${path}`, { signal });
  send["adapter.fetch()"] = async (path, signal) =>
    adapter.fetch(new Request(`http://localhost${path}`, { signal }));
});

afterAll(async () => {
  while (apps.length) {
    await apps.pop()?.close();
  }
  seen.clear();
});

for (const mode of ["served", "adapter.fetch()"] as const) {
  describe(`req.socket, the disconnect source Nest's SSE reads (${mode})`, () => {
    it(
      "is defined, so Nest's `request.socket ?? response` picks it",
      async () => {
        const k = crypto.randomUUID();
        const res = await send[mode](`/contract/done?k=${k}`);
        expect(await res.text()).toBe("done");
        const s = record(k);
        await within(s.handled.promise, "the handler to run");
        expect(s.req?.socket).toBeDefined();
        expect(typeof s.req?.socket.once).toBe("function");
        expect(typeof s.req?.socket.removeListener).toBe("function");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "emits 'close' and turns destroyed true when the client disconnects",
      async () => {
        const k = crypto.randomUUID();
        const ac = new AbortController();
        const res = await send[mode](`/contract/open?k=${k}`, ac.signal);
        const reader = res.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        const s = record(k);
        expect(s.destroyedAtStart).toBe(false);
        expect(s.req?.socket.destroyed).toBe(false);

        ac.abort();
        await reader.cancel().catch(() => undefined);
        await within(
          s.socketClosed.promise,
          "req.socket 'close' after the disconnect",
        );
        expect(s.req?.socket.destroyed).toBe(true);
        await within(
          s.responseClosed.promise,
          "the response's 'close' after the disconnect",
        );
        expect(s.emitted).toContain("socket close");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "reads destroyed true for a listener that arrives after the disconnect, and still emits 'close' to it",
      async () => {
        const k = crypto.randomUUID();
        const ac = new AbortController();
        // Not awaited: it rejects with the abort, served and through
        // adapter.fetch() alike.
        void send[mode](`/contract/held?k=${k}`, ac.signal).catch(
          () => undefined,
        );
        const s = record(k);
        await within(s.handled.promise, "the handler to run");
        expect(s.destroyedAtStart).toBe(false);

        ac.abort();
        await within(
          s.responseClosed.promise,
          "the response's 'close' after the disconnect",
        );
        // Nest 12 checks this before listening; Nest 11.2 listens only.
        expect(s.req?.socket.destroyed).toBe(true);
        const late = Promise.withResolvers<void>();
        s.req?.socket.once("close", () => late.resolve());
        await within(
          late.promise,
          "'close' for a listener added after the disconnect",
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "on a completed response: the response emits 'finish' then 'close', the socket stays open",
      async () => {
        const k = crypto.randomUUID();
        const res = await send[mode](`/contract/done?k=${k}`);
        expect(await res.text()).toBe("done");
        const s = record(k);
        await within(
          s.responseClosed.promise,
          "the response's 'close' after completion",
        );
        expect(s.emitted).toEqual(["response finish", "response close"]);
        // The client did not leave: Nest must not read a completion as a disconnect.
        expect(s.req?.socket.destroyed).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );
  });
}
