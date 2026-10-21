/**
 * Shutting down and listening, on `BunHttpAdapter`: `app.close()` drains the
 * requests in flight, `return503OnClosing` turns new ones away meanwhile,
 * and `listen()` takes a unix socket path and refuses a bad port.
 *
 * ```bash
 * bun 02-http-adapter/shutdown.ts
 * ```
 *
 * Worth knowing:
 *
 * - `app.close()` (and `adapter.close()`) drains, as
 *   `@nestjs/platform-express` 12 does: the server stops accepting
 *   connections, the requests in flight finish, then it stops. The wait is
 *   capped by the adapter's `closeDrainTimeout` option (10 s by default;
 *   `10-options/http-adapter-options.ts` shows a short cap and `0`), after
 *   which whatever is still open is cut. It always ends by force-closing, so
 *   nothing of the old server answers on its port afterwards.
 * - `forceCloseConnections: true` (a `NestFactory.create` option) skips the
 *   wait: requests in flight are cut at once.
 * - `return503OnClosing: true` (a `NestFactory.create` option, Nest 12)
 *   answers every request `503 Service Unavailable`, `Connection: close`,
 *   from the moment `app.close()` begins: Nest 12 calls the adapter's
 *   `beforeClose()` before any shutdown hook, while the server still
 *   accepts requests. Nest 11 never calls `beforeClose()`, so there a
 *   request during the hooks is answered as usual; this example asks
 *   `NestApplication.prototype` for `prepareClose` (the method that calls
 *   it) and says so on a line starting `skipped:` where the `503` sits out.
 *   Calling `adapter.beforeClose()` yourself sets the same state on any Nest.
 * - `listen(port)` takes an integer from 0 to 65535 and rejects anything
 *   else with a `RangeError`; `app.listen()` rejects with it too. A string
 *   that is not a port is a unix socket path: `address()` returns the path
 *   (an `AddressInfo` for a port), `app.getUrl()` an `http+unix://` URL, and
 *   Bun removes the socket file when the server stops.
 * - No check here measures a duration. The slow request waits on a gate the
 *   script opens, so a busy machine only makes the run longer.
 */
import type {
  BeforeApplicationShutdown,
  INestApplication,
  NestApplicationOptions,
} from "@nestjs/common";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestApplication, NestFactory } from "@nestjs/core";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/**
 * The installed `@nestjs/common`'s version, for the skip line: read from its
 * `package.json` on disk, since Nest 12's `exports` map has none.
 * @returns The version string, such as "12.2.0".
 */
async function nestCommonVersion(): Promise<string> {
  let dir = dirname(Bun.resolveSync("@nestjs/common", import.meta.dir));
  for (;;) {
    const file = Bun.file(join(dir, "package.json"));
    if (await file.exists()) {
      const pkg = (await file.json()) as { name?: string; version: string };
      if (pkg.name === "@nestjs/common") return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error("@nestjs/common's package.json was not found");
    dir = parent;
  }
}

/** The installed `@nestjs/common`'s version: for the skip line only. */
const NEST_VERSION = await nestCommonVersion();

/**
 * Whether the installed core calls the adapter's `beforeClose()` as
 * `app.close()` begins (Nest 12's `NestApplication.prepareClose`): the gate
 * for the `503` checks. Asked of the class, never a version string.
 */
const CORE_CALLS_BEFORE_CLOSE =
  typeof Reflect.get(NestApplication.prototype, "prepareClose") === "function";

/** A promise with its opener, for holding a handler or a hook until the script says. */
function gate(): { promise: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

/** The gates of the run in progress; replaced by {@link resetGates}. */
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

/** Fresh gates for the next app; the hook's open unless `holdHook`. */
function resetGates(holdHook = false): void {
  gates.slowEntered = gate();
  gates.slowRelease = gate();
  gates.hookEntered = gate();
  gates.hookRelease = gate();
  if (!holdHook) gates.hookRelease.open();
}

@Controller()
class ShutdownController {
  @Get("fast")
  fast() {
    return "fast";
  }

  /** A request still running when `app.close()` begins. */
  @Get("slow")
  async slow() {
    gates.slowEntered.open();
    await gates.slowRelease.promise;
    return "slow done";
  }
}

/** A shutdown hook the script holds open, so it can send a request meanwhile. */
@Injectable()
class ShutdownHooks implements BeforeApplicationShutdown {
  async beforeApplicationShutdown() {
    gates.hookEntered.open();
    await gates.hookRelease.promise;
  }
}

@Module({ controllers: [ShutdownController], providers: [ShutdownHooks] })
class ShutdownModule {}

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

/** Creates the module's app on `adapter` and listens on 127.0.0.1, port 0. */
async function serve(
  options: NestApplicationOptions = {},
  adapter = new BunHttpAdapter(),
): Promise<{ app: INestApplication; adapter: BunHttpAdapter; url: string }> {
  const app = await NestFactory.create(ShutdownModule, adapter, {
    logger: false,
    ...options,
  });
  await app.listen(0, "127.0.0.1");
  return { app, adapter, url: await app.getUrl() };
}

/** What a shutdown answer is compared on. */
async function shape(response: Response) {
  return {
    status: response.status,
    connection: response.headers.get("connection"),
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

/** A request's outcome: its status and body, or that the connection failed. */
function outcome(request: Promise<Response>): Promise<string> {
  return request.then(
    async (response) => `${response.status} ${await response.text()}`,
    () => "failed",
  );
}

/** `ms` milliseconds: room for a broken `close()` to resolve early. */
const SETTLE_MS = 300;

/**
 * `work`, or a rejection once `ms` have passed: so a `listen()` that hangs
 * reads as a failed check, not a run that never ends. The timer is cleared
 * either way.
 */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`hung for ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, hung]);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
title("Shutting down and listening on BunHttpAdapter");
show("@nestjs/common", NEST_VERSION);

step("app.close() drains a slow request; a new one gets 503 meanwhile");
{
  resetGates(true);
  const { app, url } = await serve(closingOptions());
  /** What has happened that `close()` must not run ahead of. */
  const events: string[] = [];

  const slow = outcome(fetch(`${url}/slow`)).then((answer) => {
    events.push("slow answered");
    return answer;
  });
  await gates.slowEntered.promise;
  show("GET /slow is in flight; app.close() begins");

  const closing = app.close().then(() => {
    events.push("close resolved");
  });
  await gates.hookEntered.promise;

  // The server still accepts while the shutdown hooks run; a fresh
  // connection, as a load balancer's next request would be.
  const during = await shape(
    await fetch(`${url}/fast`, { headers: { connection: "close" } }),
  );
  show("GET /fast during the shutdown hooks", during);
  if (CORE_CALLS_BEFORE_CLOSE) {
    checkEqual(
      "return503OnClosing: a new request is 503, Connection: close, as Express answers it",
      during,
      {
        status: 503,
        connection: "close",
        contentType: "text/html; charset=utf-8",
        body: "Service Unavailable",
      },
    );
  } else {
    show(
      `skipped: Nest < 12 never calls beforeClose(), so return503OnClosing has nothing to act on; 1 check skipped on Nest ${NEST_VERSION}`,
    );
    checkEqual(
      "Nest 11: a request during the shutdown hooks is answered as usual",
      [during.status, during.body],
      [200, "fast"],
    );
  }

  gates.hookRelease.open();
  await Bun.sleep(SETTLE_MS);
  check(
    "app.close() waits while the slow request is in flight",
    events.length === 0,
    events,
  );

  // Released, the request is answered whole and close() then resolves. The
  // two are not ordered for the client: close() resolves once the server has
  // written the response, which may be a tick before the client has read it.
  gates.slowRelease.open();
  await closing;
  checkEqual(
    "the slow request finishes with its own answer, not cut, and app.close() resolves",
    { slow: await slow, events: events.toSorted() },
    { slow: "200 slow done", events: ["close resolved", "slow answered"] },
  );
  await checkRejects("after close(), the port is released", () =>
    fetch(`${url}/fast`),
  );
}

/* ------------------------------------------------------------------ */
step(
  "Without return503OnClosing, the hooks' requests are answered (every Nest)",
);
{
  resetGates(true);
  const { app, url } = await serve();
  const closing = app.close();
  await gates.hookEntered.promise;
  const during = await shape(
    await fetch(`${url}/fast`, { headers: { connection: "close" } }),
  );
  gates.hookRelease.open();
  await closing;
  checkEqual(
    "a request during the shutdown hooks is 200",
    [during.status, during.body],
    [200, "fast"],
  );
}

/* ------------------------------------------------------------------ */
step("forceCloseConnections: true cuts the request in flight");
{
  resetGates();
  // A drain cap of a minute, so a close() that waited would be seen to.
  const { app, url } = await serve(
    { forceCloseConnections: true },
    new BunHttpAdapter(0, { closeDrainTimeout: 60_000 }),
  );
  const slow = outcome(fetch(`${url}/slow`));
  await gates.slowEntered.promise;

  // `/slow` is never released: close() must not wait for it.
  const closed = await within(5000, app.close()).then(
    () => "resolved",
    (error: unknown) => String(error),
  );
  checkEqual(
    "app.close() resolves with the request still running, well inside the drain cap; the client's connection is cut",
    { closed, slow: await slow },
    { closed: "resolved", slow: "failed" },
  );
  gates.slowRelease.open();
}

/* ------------------------------------------------------------------ */
step("beforeClose() by hand: the 503 state, and listen() again clears it");
{
  resetGates();
  const { app, adapter, url } = await serve(closingOptions());
  checkEqual(
    "before beforeClose(), requests are answered",
    await outcome(fetch(`${url}/fast`)),
    "200 fast",
  );
  adapter.beforeClose();
  checkEqual(
    "after it, every request is 503 (return503OnClosing is on)",
    (await shape(await fetch(`${url}/fast`))).status,
    503,
  );
  await app.close();

  await adapter.listen(0, "127.0.0.1");
  checkEqual(
    "listening again answers normally",
    await outcome(fetch(`${adapter.url}/fast`)),
    "200 fast",
  );
  await adapter.close();
}

/* ------------------------------------------------------------------ */
step("listen(): a port out of range is a RangeError");
{
  const app = await NestFactory.create(ShutdownModule, new BunHttpAdapter(), {
    logger: false,
  });
  await checkRejects(
    "app.listen(70000) rejects",
    () => within(5000, app.listen(70000)),
    { name: "RangeError", message: /got 70000/ },
  );
  await app.close();

  const adapter = new BunHttpAdapter();
  await checkRejects("adapter.listen(-1) rejects", () => adapter.listen(-1), {
    name: "RangeError",
  });
  await checkRejects(
    "adapter.listen(65536, host) rejects",
    () => adapter.listen(65536, "127.0.0.1"),
    { name: "RangeError" },
  );
  checkEqual("and no server was started", adapter.getBunServer(), undefined);
}

/* ------------------------------------------------------------------ */
step("listen(): a unix socket path, and address()");
{
  resetGates();
  const dir = await mkdtemp(join(tmpdir(), "bun-nest-shutdown-"));
  const path = join(dir, "app.sock");
  try {
    const adapter = new BunHttpAdapter();
    const app = await NestFactory.create(ShutdownModule, adapter, {
      logger: false,
    });
    await within(5000, app.listen(path));
    show("listening on", await app.getUrl());

    checkEqual(
      "app.getUrl() is http+unix://, the path percent-encoded",
      await app.getUrl(),
      `http+unix://${encodeURIComponent(path)}`,
    );
    checkEqual("address() returns the path", adapter.address(), path);
    const served = await fetch("http://localhost/fast", {
      unix: path,
    } as RequestInit);
    checkEqual("a request over the socket", await served.text(), "fast");

    await adapter.listen(0, "127.0.0.1");
    const address = adapter.address() as AddressInfo;
    checkEqual(
      "listening on a port instead: address() is an AddressInfo",
      address,
      { address: "127.0.0.1", family: "IPv4", port: adapter.listeningPort },
    );
    check(
      "and the socket file was removed when that server stopped",
      !existsSync(path),
    );
    await app.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

summary();
