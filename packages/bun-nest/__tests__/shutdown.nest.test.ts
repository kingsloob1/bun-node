/**
 * Shutting down and listening on `BunHttpAdapter`, as `@nestjs/platform-express`
 * does on the installed Nest (nestjs-12-parity, PR-6b: G7, G8, G9).
 *
 * - **`return503OnClosing`** (Nest 12, `beforeClose()`): a request arriving
 *   while the shutdown hooks run is answered `503 Service Unavailable` with
 *   `Connection: close`, compared with Express's answer on the same module.
 * - **Draining** (the user's Q6): `app.close()` lets an in-flight request
 *   finish, waits at most the `closeDrainTimeout` adapter option (10 s;
 *   shortened here) for a stream that never ends, and waits for nothing with
 *   `forceCloseConnections: true` or `closeDrainTimeout: 0`.
 * - **The port-release rule** (CLAUDE.md): whatever the drain, nothing of the
 *   closed server answers once `close()` has resolved, even with a new server
 *   on the same port and a stream left open.
 * - **`listen()` errors and socket paths** (Nest 12.1.3's contract, #18053 and
 *   #18059): a port out of range rejects `app.listen()` instead of hanging it
 *   with an unhandled rejection, and a socket path is listened on, with
 *   `getUrl()` giving `http+unix://…`.
 *
 * The shape of Nest's `integration/graceful-shutdown/e2e/express.spec.ts` and
 * `integration/nest-application/listen/e2e/express.spec.ts` (v12.1.3),
 * ported, not copied. Every request is served (these are socket behaviours),
 * every server binds port 0, and the waits are gated on handler-written
 * markers rather than timing, except the drain cap, which is the timing.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type {
  BeforeApplicationShutdown,
  INestApplication,
  MessageEvent,
  NestApplicationOptions,
} from "@nestjs/common";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller, Get, Injectable, Module, Sse } from "@nestjs/common";
import { NestApplication, NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { afterEach, describe, expect, it } from "bun:test";
import { Observable } from "rxjs";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import "reflect-metadata";

/**
 * Whether the installed core calls the adapter's `beforeClose()` before the
 * shutdown hooks (Nest 12's `NestApplication.prepareClose`). A capability,
 * not a version: Nest 11 has neither, and no `return503OnClosing` either.
 */
const coreCallsBeforeClose =
  typeof Reflect.get(NestApplication.prototype, "prepareClose") === "function";

/**
 * `extra` with `return503OnClosing: true`, built rather than written as a
 * literal: Nest 11's `NestApplicationOptions` has no such key.
 */
function closingOptions(
  extra: NestApplicationOptions = {},
): NestApplicationOptions {
  return {
    ...extra,
    ...(Object.fromEntries([
      ["return503OnClosing", true],
    ]) as NestApplicationOptions),
  };
}

/** A promise with its resolver, for gating a handler or a hook. */
function gate(): { promise: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

/** Per-test gates, reset in `afterEach`. */
const gates = {
  /** Opened by `/slow` once it is running. */
  slowEntered: gate(),
  /** `/slow` answers once this is opened. */
  slowRelease: gate(),
  /** Opened by the shutdown hook once it is running. */
  hookEntered: gate(),
  /** The shutdown hook returns once this is opened. */
  hookRelease: gate(),
};

@Controller()
class ShutdownController {
  @Get("fast")
  fast() {
    return "fast";
  }

  @Get("slow")
  async slow() {
    gates.slowEntered.open();
    await gates.slowRelease.promise;
    return "slow done";
  }

  @Sse("endless")
  endless(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const timer = setInterval(() => subscriber.next({ data: "tick" }), 20);
      return () => clearInterval(timer);
    });
  }
}

@Injectable()
class ShutdownHooks implements BeforeApplicationShutdown {
  async beforeApplicationShutdown() {
    gates.hookEntered.open();
    await gates.hookRelease.promise;
  }
}

@Module({ controllers: [ShutdownController], providers: [ShutdownHooks] })
class ShutdownModule {}

/** A `BunHttpAdapter` whose drain cap is `cap` ms instead of 10 s. */
function drainingFor(cap: number): BunHttpAdapter {
  return new BunHttpAdapter(0, { closeDrainTimeout: cap });
}

/** Apps and temporary directories to tear down after each test. */
const toClose: INestApplication[] = [];
const toRemove: string[] = [];

afterEach(async () => {
  // Release anything a failed test left gated, so its close can finish.
  gates.slowRelease.open();
  gates.hookRelease.open();
  for (const app of toClose.splice(0)) {
    await app.close().catch(() => undefined);
  }
  for (const dir of toRemove.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  gates.slowEntered = gate();
  gates.slowRelease = gate();
  gates.hookEntered = gate();
  gates.hookRelease = gate();
});

/** Creates the module's app on `adapter` (ours unless given) and listens on 127.0.0.1:0. */
async function serve(
  options: NestApplicationOptions = {},
  adapter: BunHttpAdapter | ExpressAdapter = new BunHttpAdapter(),
): Promise<{ app: INestApplication; url: string }> {
  const app = await NestFactory.create(ShutdownModule, adapter, {
    logger: false,
    ...options,
  });
  toClose.push(app);
  await app.listen(0, "127.0.0.1");
  return { app, url: await app.getUrl() };
}

/** The parts of a response a shutdown answer is compared on. */
async function shape(response: Response) {
  return {
    status: response.status,
    connection: response.headers.get("connection"),
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

/** A request on a fresh connection, during the shutdown hooks. */
async function requestDuringHooks(
  options: NestApplicationOptions,
  adapter: BunHttpAdapter | ExpressAdapter,
) {
  const { app, url } = await serve(options, adapter);
  const closing = app.close();
  await gates.hookEntered.promise;
  const answer = await shape(
    await fetch(`${url}/fast`, { headers: { connection: "close" } }),
  );
  gates.hookRelease.open();
  await closing;
  return answer;
}

describe.skipIf(!coreCallsBeforeClose)(
  "return503OnClosing (Nest 12: beforeClose)",
  () => {
    it("answers 503 with Connection: close while the shutdown hooks run, as Express", async () => {
      const ours = await requestDuringHooks(
        closingOptions(),
        new BunHttpAdapter(),
      );
      gates.hookEntered = gate();
      gates.hookRelease = gate();
      // `forceCloseConnections` only so Express's close does not wait for
      // the idle keep-alive connection; it changes nothing about the 503.
      const express = await requestDuringHooks(
        closingOptions({ forceCloseConnections: true }),
        new ExpressAdapter(),
      );
      expect(ours).toEqual({
        status: 503,
        connection: "close",
        contentType: "text/html; charset=utf-8",
        body: "Service Unavailable",
      });
      expect(ours).toEqual(express);
    });

    it("still answers while the hooks run without the option, as Express", async () => {
      const ours = await requestDuringHooks({}, new BunHttpAdapter());
      expect(ours.status).toBe(200);
      expect(ours.body).toBe("fast");
    });

    it("answers normally again once the adapter listens after a close", async () => {
      const adapter = new BunHttpAdapter();
      const { app } = await serve(closingOptions(), adapter);
      gates.hookRelease.open();
      await app.close();
      await adapter.listen(0, "127.0.0.1");
      const port = adapter.getBunServer()?.port;
      const response = await fetch(`http://127.0.0.1:${port}/fast`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("fast");
      await adapter.close();
    });
  },
);

describe("close(): draining in-flight requests", () => {
  it("lets an in-flight request finish before resolving", async () => {
    gates.hookRelease.open();
    const { app, url } = await serve();
    const inflight = fetch(`${url}/slow`).then(shape);
    await gates.slowEntered.promise;

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    // Not resolved while the request is still running.
    await Bun.sleep(100);
    expect(closed).toBe(false);

    gates.slowRelease.open();
    expect(await inflight).toMatchObject({ status: 200, body: "slow done" });
    await closing;
    expect(closed).toBe(true);
  });

  it("cuts an in-flight request at once with forceCloseConnections", async () => {
    gates.hookRelease.open();
    const { app, url } = await serve({ forceCloseConnections: true });
    const inflight = fetch(`${url}/slow`).then(
      (response) => `answered ${response.status}`,
      (error: unknown) => `failed: ${String(error)}`,
    );
    await gates.slowEntered.promise;

    await app.close();
    expect(await inflight).toStartWith("failed:");
  });

  it("cuts a stream that never ends once the drain cap passes", async () => {
    gates.hookRelease.open();
    const adapter = drainingFor(300);
    const { app, url } = await serve({}, adapter);
    const server = adapter.getBunServer();
    const reader = (await fetch(`${url}/endless`)).body!.getReader();
    await reader.read();
    // Keep reading, as a live client does, until the stream is cut.
    const ended = (async () => {
      try {
        while (!(await reader.read()).done) {
          // drain
        }
        return "ended";
      } catch {
        return "cut";
      }
    })();

    const started = performance.now();
    await app.close();
    const took = performance.now() - started;

    // The cap was waited for, then the stream cut, before close() resolved.
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(5000);
    expect(server?.pendingRequests).toBe(0);
    expect(["ended", "cut"]).toContain(await ended);
  });

  it("leaves nothing of the closed server answering on its port (the port-release rule)", async () => {
    gates.hookRelease.open();
    const adapter = drainingFor(200);
    const { app, url } = await serve({}, adapter);
    const port = Number(new URL(url).port);

    // A keep-alive client and an open stream on the old server.
    expect(await (await fetch(`${url}/fast`)).text()).toBe("fast");
    const reader = (await fetch(`${url}/endless`)).body!.getReader();
    await reader.read();

    await app.close();

    // A new server on the very same port.
    const next = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: () => new Response("next"),
    });
    try {
      // The pooled client reaches the new server, never the stale one.
      for (let i = 0; i < 4; i++) {
        expect(await (await fetch(`${url}/fast`)).text()).toBe("next");
      }
      // And the old stream delivers nothing more: it was cut by close().
      const after = await Promise.race([
        (async () => {
          try {
            while (!(await reader.read()).done) {
              // what was buffered before the cut
            }
            return "ended";
          } catch {
            return "ended";
          }
        })(),
        Bun.sleep(1000).then(() => "still flowing"),
      ]);
      expect(after).toBe("ended");
    } finally {
      await next.stop(true);
    }
  });

  it("waits up to a custom closeDrainTimeout for an in-flight request", async () => {
    gates.hookRelease.open();
    const { app, url } = await serve({}, drainingFor(250));
    const inflight = fetch(`${url}/slow`).then(
      (response) => `answered ${response.status}`,
      (error: unknown) => `failed: ${String(error)}`,
    );
    await gates.slowEntered.promise;

    const started = performance.now();
    await app.close();
    const took = performance.now() - started;

    // Never released: cut once the 250 ms cap passed, not after 10 s.
    expect(took).toBeGreaterThanOrEqual(240);
    expect(took).toBeLessThan(5000);
    expect(await inflight).toStartWith("failed:");
  });

  it("cuts an in-flight request at once with closeDrainTimeout: 0", async () => {
    gates.hookRelease.open();
    const { app, url } = await serve({}, drainingFor(0));
    const inflight = fetch(`${url}/slow`).then(
      (response) => `answered ${response.status}`,
      (error: unknown) => `failed: ${String(error)}`,
    );
    await gates.slowEntered.promise;

    const started = performance.now();
    await app.close();
    expect(performance.now() - started).toBeLessThan(200);
    expect(await inflight).toStartWith("failed:");
  });

  it("refuses a negative or non-finite closeDrainTimeout at construction", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => drainingFor(bad)).toThrow(RangeError);
    }
    expect(
      () =>
        new BunHttpAdapter(0, {
          closeDrainTimeout: "100" as unknown as number,
        }),
    ).toThrow(RangeError);
    expect(() => drainingFor(0)).not.toThrow();
  });

  it("resolves at once when nothing is in flight", async () => {
    gates.hookRelease.open();
    const { app } = await serve();
    const started = performance.now();
    await app.close();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("listen(): errors", () => {
  it("rejects app.listen() for a port out of range, with no unhandled rejection", async () => {
    const app = await NestFactory.create(ShutdownModule, new BunHttpAdapter(), {
      logger: false,
    });
    toClose.push(app);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const outcome = await Promise.race([
        app.listen(70000).then(
          () => "resolved",
          (error: unknown) => error,
        ),
        Bun.sleep(3000).then(() => "hung"),
      ]);
      expect(outcome).toBeInstanceOf(RangeError);
      expect(String(outcome)).toContain("got 70000");
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects a direct listen() for a port out of range", async () => {
    const adapter = new BunHttpAdapter();
    await expect(adapter.listen(-1)).rejects.toThrow(RangeError);
    await expect(adapter.listen(65536, "127.0.0.1")).rejects.toThrow(
      RangeError,
    );
    expect(adapter.getBunServer()).toBeUndefined();
  });
});

describe("listen(): a unix socket path", () => {
  function socketPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "bun-nest-sock-"));
    toRemove.push(dir);
    return join(dir, "app.sock");
  }

  it("listens on it, gives an http+unix:// URL and serves requests there", async () => {
    gates.hookRelease.open();
    const path = socketPath();
    const adapter = new BunHttpAdapter();
    const app = await NestFactory.create(ShutdownModule, adapter, {
      logger: false,
    });
    toClose.push(app);
    await app.listen(path);

    expect(await app.getUrl()).toBe(`http+unix://${encodeURIComponent(path)}`);
    expect(adapter.address()).toBe(path);
    const response = await fetch("http://localhost/fast", {
      unix: path,
    } as RequestInit);
    expect(await response.text()).toBe("fast");
    // The socket-free fetch() still works on a socket-path server.
    expect(await (await adapter.fetch("/fast")).text()).toBe("fast");

    await app.close();
    // Bun removes the socket file when the server stops, as Node does.
    expect(existsSync(path)).toBe(false);
  });

  it("rejects app.listen() when the path is taken, as Node's EADDRINUSE", async () => {
    const path = socketPath();
    writeFileSync(path, "");
    const app = await NestFactory.create(ShutdownModule, new BunHttpAdapter(), {
      logger: false,
    });
    toClose.push(app);
    // Nest logs the error it rejects with; the adapter's logger too.
    const outcome = await Promise.race([
      app.listen(path).then(
        () => "resolved",
        (error: unknown) => String(error),
      ),
      Bun.sleep(3000).then(() => "hung"),
    ]);
    expect(outcome).toContain("EADDRINUSE");
  });

  it("moves between a socket path and a port", async () => {
    const path = socketPath();
    const adapter = new BunHttpAdapter();
    await adapter.listen(path);
    expect(adapter.address()).toBe(path);
    await adapter.listen(0, "127.0.0.1");
    const address = adapter.address();
    expect(typeof address).toBe("object");
    expect(existsSync(path)).toBe(false);
    await adapter.listen(path);
    expect(adapter.address()).toBe(path);
    await adapter.close();
  });
});
