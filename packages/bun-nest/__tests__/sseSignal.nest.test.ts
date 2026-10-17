/**
 * `@SseSignal()` (`@nestjs/common` 11.2.x and 12, nestjs/nest#17469) on
 * `BunHttpAdapter`, against `@nestjs/platform-express` in the same test.
 *
 * Nest hands an `@Sse()` handler an `AbortSignal` for the lifetime of the
 * response: `RouterExecutionContext.attachSseAbortSignal` puts an
 * `AbortController` on the request before the handler runs, and
 * `RouterResponseController.sse()` aborts it on every exit path — the client
 * leaving (it waits on `request.socket ?? response` emitting `close`, and on
 * 12 also reads `socket.destroyed`), the Observable completing or erroring,
 * and a response something upstream already ended (`writableEnded`).
 *
 * Each case runs on three clients — Express served, ours served and ours
 * through the socket-free `adapter.fetch()` (a disconnect there is the
 * `Request`'s own signal) — and the outcomes must be equal, Express's being
 * the expectation. The facts the feature promises (the signal arrived and
 * aborted, no subscription after an early disconnect) are also asserted
 * outright, so a regression shared by both adapters still fails.
 *
 * Gated on `typeof common.SseSignal === "function"`: Nest 11.1.27 (develop's
 * lock) has no `@SseSignal()`, so these skip there and run in the
 * `scripts/nest-matrix.ts` columns (11.2.7, 12.x).
 *
 * `reflect-metadata` is imported last per the import-sort rule. No top-level
 * `await`: it perturbs decorator metadata in other gateway test files.
 */
import type {
  CallHandler,
  CanActivate,
  ExecutionContext,
  INestApplication,
  MessageEvent,
  NestInterceptor,
} from "@nestjs/common";
import * as common from "@nestjs/common";
import {
  Controller,
  Module,
  Query,
  Sse,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { interval, map, Observable, take, throwError } from "rxjs";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import "reflect-metadata";

/** `@SseSignal()`'s shape, read off the namespace so Nest 11.1.x still type-checks. */
type SseSignalFactory = () => ParameterDecorator;

/** Nest's `@SseSignal()`, or `undefined` on a Nest without it. */
const NestSseSignal = (common as unknown as Record<string, unknown>)
  .SseSignal as SseSignalFactory | undefined;

/** Whether this Nest has `@SseSignal()`; the suite skips (visibly) without it. */
const hasSseSignal = typeof NestSseSignal === "function";

/** The decorator the controllers use: a no-op where Nest has none, so they still load. */
const SseSignal: SseSignalFactory = NestSseSignal ?? (() => () => undefined);

/** How long any one awaited event may take before the case reports it missing. */
const DEADLINE_MS = 5000;

/** A test's own timeout: several deadlines, so a missing event fails with its name, not a bare timeout. */
const TEST_TIMEOUT_MS = 30_000;

/**
 * What one request's handler saw. Keyed by the `k` query parameter, so the
 * three clients' requests never share one.
 */
class Probe {
  /** The value `@SseSignal()` injected. */
  signal: AbortSignal | undefined;
  /** `signal.aborted` when the handler started. */
  abortedAtStart: boolean | undefined;
  /** `signal.aborted` once the handler's async setup finished. */
  abortedAfterSetup: boolean | undefined;
  /** Whether the returned Observable was subscribed. */
  subscribed = false;
  /** Whether the returned Observable's subscription was torn down. */
  unsubscribed = false;
  /** Whether a wrapping interceptor ran. */
  intercepted = false;
  /** Resolves when the handler starts. */
  readonly started = Promise.withResolvers<void>();
  /** The test resolves this to let a slow handler's setup finish. */
  readonly release = Promise.withResolvers<void>();
  /** Resolves when a slow handler's setup has returned its Observable. */
  readonly setupDone = Promise.withResolvers<void>();
  /** Resolves when the signal aborts. */
  readonly aborted = Promise.withResolvers<void>();
  /** Resolves when the subscription is torn down. */
  readonly torndown = Promise.withResolvers<void>();

  /** Records the injected signal and wires `aborted`. */
  watch(signal: AbortSignal | undefined): void {
    this.signal = signal;
    this.abortedAtStart = signal?.aborted;
    if (signal?.aborted) {
      this.aborted.resolve();
    }
    signal?.addEventListener("abort", () => this.aborted.resolve(), {
      once: true,
    });
    this.started.resolve();
  }
}

/** Every request's probe, by key. */
const probes = new Map<string, Probe>();

/** The probe for key `k`, created on first use. */
function probe(k: string): Probe {
  let found = probes.get(k);
  if (!found) {
    found = new Probe();
    probes.set(k, found);
  }
  return found;
}

/** An endless Observable of `data` events whose teardown is recorded on `p`. */
function endless(p: Probe): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    p.subscribed = true;
    let n = 0;
    const timer = setInterval(() => subscriber.next({ data: `n${n++}` }), 5);
    return () => {
      clearInterval(timer);
      p.unsubscribed = true;
      p.torndown.resolve();
    };
  });
}

/** Wraps the handler and records that it ran: the path that attaches the signal before interceptors. */
class Recording implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ query: { k: string } }>();
    probe(req.query.k).intercepted = true;
    return next.handle();
  }
}

/** Ends the response before the handler runs, so Nest takes its `writableEnded` branch. */
class EndsResponse implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const res = context
      .switchToHttp()
      .getResponse<{ status: (code: number) => unknown; end: () => void }>();
    res.status(204);
    res.end();
    return true;
  }
}

@Controller("signal")
class SignalController {
  /** Async setup the test holds open, then an endless stream. */
  @Sse("slow")
  async slow(
    @Query("k") k: string,
    @SseSignal() signal: AbortSignal | undefined,
  ): Promise<Observable<MessageEvent>> {
    const p = probe(k);
    p.watch(signal);
    await p.release.promise;
    p.abortedAfterSetup = signal?.aborted;
    p.setupDone.resolve();
    return endless(p);
  }

  @Sse("endless")
  endless(
    @Query("k") k: string,
    @SseSignal() signal: AbortSignal | undefined,
  ): Observable<MessageEvent> {
    const p = probe(k);
    p.watch(signal);
    return endless(p);
  }

  /** Two events, emitted asynchronously, then completion. */
  @Sse("complete")
  complete(
    @Query("k") k: string,
    @SseSignal() signal: AbortSignal | undefined,
  ): Observable<MessageEvent> {
    probe(k).watch(signal);
    return interval(5).pipe(
      take(2),
      map((n) => ({ data: `c${n}` })),
    );
  }

  /** One event, then an error. */
  @Sse("error")
  error(
    @Query("k") k: string,
    @SseSignal() signal: AbortSignal | undefined,
  ): Observable<MessageEvent> {
    probe(k).watch(signal);
    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next({ data: "first" });
      const timer = setTimeout(() => subscriber.error(new Error("boom")), 5);
      return () => clearTimeout(timer);
    });
  }

  /** An error before the first event (a 500). */
  @Sse("error-before")
  errorBefore(
    @Query("k") k: string,
    @SseSignal() signal: AbortSignal | undefined,
  ): Observable<MessageEvent> {
    probe(k).watch(signal);
    return throwError(() => new Error("before the first event"));
  }

  /** As `slow`, wrapped by an interceptor. */
  @Sse("intercepted")
  @UseInterceptors(Recording)
  async intercepted(
    @Query("k") k: string,
    @SseSignal() signal: AbortSignal | undefined,
  ): Promise<Observable<MessageEvent>> {
    const p = probe(k);
    p.watch(signal);
    await p.release.promise;
    p.abortedAfterSetup = signal?.aborted;
    p.setupDone.resolve();
    return endless(p);
  }

  /** Wrapped by an interceptor, completes on its own. */
  @Sse("intercepted-complete")
  @UseInterceptors(Recording)
  interceptedComplete(
    @Query("k") k: string,
    @SseSignal() signal: AbortSignal | undefined,
  ): Observable<MessageEvent> {
    probe(k).watch(signal);
    return interval(5).pipe(
      take(2),
      map((n) => ({ data: `i${n}` })),
    );
  }

  /** A guard ended the response before the handler ran. */
  @Sse("ended")
  @UseGuards(EndsResponse)
  async ended(
    @Query("k") k: string,
    @SseSignal() signal: AbortSignal | undefined,
  ): Promise<Observable<MessageEvent>> {
    const p = probe(k);
    p.watch(signal);
    await p.release.promise;
    p.abortedAfterSetup = signal?.aborted;
    p.setupDone.resolve();
    return endless(p);
  }
}

@Module({ controllers: [SignalController] })
class SignalModule {}

/** Who answers a case. */
type ClientName = "express" | "bun served" | "bun adapter.fetch()";

/** Sends a `GET` for `path` (with `signal`) to one application. */
type Send = (path: string, signal?: AbortSignal) => Promise<Response>;

/** Applications to close after the suite. */
const apps: INestApplication[] = [];

/** One sender per client, set by `beforeAll`. */
const clients = {} as Record<ClientName, Send>;

/** Resolves `true` when `pending` settles within {@link DEADLINE_MS}, `false` otherwise. */
async function settles(pending: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(resolve, DEADLINE_MS, false);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Awaits `pending` or throws, naming `what`, once {@link DEADLINE_MS} passes. */
async function expectWithin(pending: Promise<unknown>, what: string) {
  if (!(await settles(pending))) {
    throw new Error(`${what}: nothing within ${DEADLINE_MS} ms`);
  }
}

/**
 * Lets Nest act on a setup that resolved after the disconnect. What is
 * checked afterwards is an absence (no subscription), which no event can
 * announce; Nest decides it in the same microtask chain, so a few macrotasks
 * are ample.
 */
async function letNestSettle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Reads a body to its end, or what arrived by the deadline. */
async function readBody(
  res: Response,
): Promise<{ text: string; ended: boolean }> {
  if (!res.body) {
    return { text: "", ended: true };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = performance.now() + DEADLINE_MS;
  for (;;) {
    const left = deadline - performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = await Promise.race([
      reader.read(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(resolve, Math.max(0, left), "timeout");
      }),
    ]);
    clearTimeout(timer);
    if (read === "timeout") {
      await reader.cancel().catch(() => undefined);
      return { text, ended: false };
    }
    if (read.done) {
      return { text, ended: true };
    }
    text += decoder.decode(read.value, { stream: true });
  }
}

/** The handler-side facts of one request, as plain data for comparison. */
function facts(p: Probe) {
  return {
    gotSignal: p.signal instanceof AbortSignal,
    abortedAtStart: p.abortedAtStart,
    abortedAfterSetup: p.abortedAfterSetup,
    subscribed: p.subscribed,
    unsubscribed: p.unsubscribed,
    intercepted: p.intercepted,
    aborted: p.signal?.aborted ?? false,
  };
}

/** A fresh key for one request. */
function key(client: ClientName, name: string): string {
  return `${name}-${client.replaceAll(/\W/g, "")}-${crypto.randomUUID()}`;
}

/** The client disconnects while the handler's async setup is still running. */
async function disconnectDuringSetup(client: ClientName, path: string) {
  const k = key(client, path);
  const p = probe(k);
  const ac = new AbortController();
  const pending = clients[client](`/signal/${path}?k=${k}`, ac.signal).then(
    () => "response",
    () => "rejected",
  );
  await expectWithin(p.started.promise, `${client}: the handler to start`);
  ac.abort();
  const abortedDuringSetup = await settles(p.aborted.promise);
  p.release.resolve();
  await expectWithin(p.setupDone.promise, `${client}: the setup to return`);
  await letNestSettle();
  await settles(pending);
  return { abortedDuringSetup, ...facts(p) };
}

/** The client disconnects after the first event. */
async function disconnectMidStream(client: ClientName) {
  const k = key(client, "endless");
  const p = probe(k);
  const ac = new AbortController();
  const res = await clients[client](`/signal/endless?k=${k}`, ac.signal);
  const reader = res.body!.getReader();
  const first = await reader.read();
  ac.abort();
  await reader.cancel().catch(() => undefined);
  const abortedInTime = await settles(p.aborted.promise);
  const torndownInTime = await settles(p.torndown.promise);
  return {
    status: res.status,
    gotData: !first.done,
    abortedInTime,
    torndownInTime,
    ...facts(p),
  };
}

/** The stream runs to its own end (completion or error). */
async function runToEnd(client: ClientName, path: string) {
  const k = key(client, path);
  const p = probe(k);
  const res = await clients[client](`/signal/${path}?k=${k}`);
  const body = await readBody(res);
  const abortedInTime = await settles(p.aborted.promise);
  return {
    status: res.status,
    contentType: res.headers.get("content-type")?.split(";")[0] ?? null,
    ...body,
    abortedInTime,
    ...facts(p),
  };
}

/** A guard ended the response; the handler's setup is let finish after the 204 arrives. */
async function alreadyEnded(client: ClientName) {
  const k = key(client, "ended");
  const p = probe(k);
  const res = await clients[client](`/signal/ended?k=${k}`);
  const body = await readBody(res);
  await expectWithin(p.started.promise, `${client}: the handler to start`);
  p.release.resolve();
  await expectWithin(p.setupDone.promise, `${client}: the setup to return`);
  await letNestSettle();
  return { status: res.status, ...body, ...facts(p) };
}

/** The clients, Express first: its outcome is the expectation. */
const CLIENTS: ClientName[] = ["express", "bun served", "bun adapter.fetch()"];

/** Runs `scenario` on every client and asserts ours match Express. */
async function differential<T>(
  scenario: (client: ClientName) => Promise<T>,
): Promise<T> {
  const outcomes: Partial<Record<ClientName, T>> = {};
  for (const client of CLIENTS) {
    outcomes[client] = await scenario(client);
  }
  expect(outcomes["bun served"]).toEqual(outcomes.express!);
  expect(outcomes["bun adapter.fetch()"]).toEqual(outcomes.express!);
  return outcomes.express!;
}

describe.skipIf(!hasSseSignal)(
  "@SseSignal() on BunHttpAdapter vs platform-express",
  () => {
    beforeAll(async () => {
      const express = await NestFactory.create(
        SignalModule,
        new ExpressAdapter(),
        { logger: false },
      );
      apps.push(express);
      await express.listen(0, "127.0.0.1");
      const expressUrl = await express.getUrl();

      const served = await NestFactory.create(
        SignalModule,
        new BunHttpAdapter(0),
        { logger: false },
      );
      apps.push(served);
      await served.listen(0, "127.0.0.1");
      const servedUrl = await served.getUrl();

      const adapter = new BunHttpAdapter();
      const fetched = await NestFactory.create(SignalModule, adapter, {
        logger: false,
      });
      apps.push(fetched);
      await fetched.init();

      clients.express = async (path, signal) =>
        fetch(`${expressUrl}${path}`, { signal });
      clients["bun served"] = async (path, signal) =>
        fetch(`${servedUrl}${path}`, { signal });
      clients["bun adapter.fetch()"] = async (path, signal) =>
        adapter.fetch(new Request(`http://localhost${path}`, { signal }));
    });

    afterAll(async () => {
      while (apps.length) {
        await apps.pop()?.close();
      }
      probes.clear();
    });

    it(
      "a disconnect during async setup aborts the signal, and the stream is never subscribed",
      async () => {
        const outcome = await differential((client) =>
          disconnectDuringSetup(client, "slow"),
        );
        expect(outcome).toMatchObject({
          gotSignal: true,
          abortedAtStart: false,
          abortedDuringSetup: true,
          abortedAfterSetup: true,
          subscribed: false,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "a disconnect mid-stream aborts the signal and tears the subscription down",
      async () => {
        const outcome = await differential(disconnectMidStream);
        expect(outcome).toMatchObject({
          status: 200,
          gotData: true,
          abortedInTime: true,
          torndownInTime: true,
          subscribed: true,
          unsubscribed: true,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "the signal aborts when the Observable completes",
      async () => {
        const outcome = await differential((client) =>
          runToEnd(client, "complete"),
        );
        expect(outcome).toMatchObject({
          status: 200,
          contentType: "text/event-stream",
          ended: true,
          abortedAtStart: false,
          abortedInTime: true,
        });
        expect(outcome.text).toContain("data: c1");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "the signal aborts when the Observable errors mid-stream",
      async () => {
        const outcome = await differential((client) =>
          runToEnd(client, "error"),
        );
        expect(outcome).toMatchObject({
          status: 200,
          ended: true,
          abortedAtStart: false,
          abortedInTime: true,
        });
        expect(outcome.text).toContain("event: error");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "the signal aborts when the Observable errors before its first event",
      async () => {
        const outcome = await differential((client) =>
          runToEnd(client, "error-before"),
        );
        expect(outcome).toMatchObject({
          status: 500,
          abortedAtStart: false,
          abortedInTime: true,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "an interceptor-wrapped handler gets the signal, and a disconnect during setup aborts it",
      async () => {
        const outcome = await differential((client) =>
          disconnectDuringSetup(client, "intercepted"),
        );
        expect(outcome).toMatchObject({
          gotSignal: true,
          intercepted: true,
          abortedDuringSetup: true,
          abortedAfterSetup: true,
          subscribed: false,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "an interceptor-wrapped handler's signal aborts on completion",
      async () => {
        const outcome = await differential((client) =>
          runToEnd(client, "intercepted-complete"),
        );
        expect(outcome).toMatchObject({
          status: 200,
          ended: true,
          gotSignal: true,
          intercepted: true,
          abortedInTime: true,
        });
        expect(outcome.text).toContain("data: i1");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "a response already ended before the handler ran aborts the signal at once (writableEnded)",
      async () => {
        const outcome = await differential(alreadyEnded);
        expect(outcome).toMatchObject({
          status: 204,
          text: "",
          gotSignal: true,
          abortedAtStart: true,
          abortedAfterSetup: true,
          subscribed: false,
        });
      },
      TEST_TIMEOUT_MS,
    );
  },
);

describe.skipIf(hasSseSignal)("@SseSignal() is absent from this Nest", () => {
  it("skips the @SseSignal() suite: @nestjs/common has no SseSignal export", () => {
    expect(NestSseSignal).toBeUndefined();
  });
});
