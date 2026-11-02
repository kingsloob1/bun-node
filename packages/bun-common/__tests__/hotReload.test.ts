/**
 * `BunHttpAdapter` under `bun --hot`, in a real child process.
 *
 * `bun --hot` re-evaluates every module on an edit and keeps the process, so
 * a module that builds an adapter and calls `listen(port)` runs again while
 * the first server is still bound. Bun gives every `Bun.serve()` server an
 * `id` (`[http]-tcp:<hostname>:<port>`, or `[http]-unix:<path>`, when the
 * options set none) and, under `--hot`, a `Bun.serve()` whose `id` is taken
 * reloads that server with the new options instead of binding again
 * (`Serve.Options.id` in bun-types; oven-sh/bun#7207). The adapter passes no
 * `id`, so its re-evaluated `listen()` reloads the running server: the new
 * routes and WebSocket handlers answer on the same port, with no
 * `EADDRINUSE`. These tests pin that:
 *
 * - HTTP: the edited handler answers on the same port; no `EADDRINUSE`;
 *   `close()` still releases the port, and the next edit listens again.
 * - WebSocket: a new connection and one opened before the edit both reach
 *   the edited handler.
 * - Port `0`: the re-evaluated `listen(0)` keeps the OS-assigned port.
 * - The control: with `server: { id: null }` (Bun's switch for the reuse)
 *   the re-evaluated `listen()` fails with `EADDRINUSE` and the old handler
 *   keeps answering, which is what these tests would see if the adapter ever
 *   passed an `id` of its own per instance.
 * - `devTypes()`: a watcher connected before the edit stays connected, keeps
 *   its token, and gets `changed` with the edited app's hash.
 * - Without `--hot`, a second `listen()` on a bound port still rejects with
 *   `EADDRINUSE`; under `--hot` the same second `listen()` takes the server
 *   over (Bun's design, oven-sh/bun#7207), and two adapters on port `0`
 *   share one server unless each has a `server.id`.
 *
 * Each child runs from this package's directory (its `tsconfig.json` and
 * `node_modules`), is killed by its PID, and every wait is bounded by
 * `HOT_WAIT_MS` with the child's output in the failure.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { getPort } from "../lib/utils/native";
import type { HotChild, HotEvent } from "./hotChild";
import { bodyAt, startChild } from "./hotChild";

/** This package's directory: the children's working directory. */
const PACKAGE_DIR = join(import.meta.dir, "..");

/** The adapter module the fixtures import, by absolute path. */
const ADAPTER_MODULE = join(PACKAGE_DIR, "lib", "BunHttpAdapter.ts");

/** A whole test: two children's startup and two reloads, with margin. */
const TEST_TIMEOUT_MS = 45_000;

/** The children started by the running test, stopped after it. */
const children: HotChild[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.stop()));
});

/** Starts a fixture and registers it for {@link afterEach}. */
function start(source: string, hot = true): HotChild {
  const child = startChild({ source, hot, cwd: PACKAGE_DIR });
  children.push(child);
  return child;
}

/**
 * The fixture app, at `version`: `GET /` answers the version, `GET /close`
 * closes the adapter (reporting `closed`), and `/echo` is a WebSocket route
 * answering `<version>:<message>`. It listens on `port` and reports
 * `listening` (with the port) or `failed` (with the error's code).
 */
function adapterFixture(
  version: string,
  port: number,
  adapterOptions = "{}",
): string {
  return `
import { BunHttpAdapter } from ${JSON.stringify(ADAPTER_MODULE)};
const version = ${JSON.stringify(version)};
const report = (event: string, fields: object = {}) =>
  console.log(JSON.stringify({ event, version, ...fields }));
const app = new BunHttpAdapter(0, ${adapterOptions});
app.get("/", (_req, res) => {
  res.send(version);
});
app.get("/close", (_req, res) => {
  res.send("closing");
  setTimeout(() => {
    void app.close().then(() => report("closed"));
  }, 20);
});
app.ws("/echo", {
  message: (ws, message) => {
    ws.send(version + ":" + String(message));
  },
});
try {
  const server = await app.listen(${port});
  report("listening", { port: server.port });
} catch (error) {
  report("failed", { code: (error as { code?: string }).code });
}
`;
}

/** The root URL of a loopback port a fixture reported. */
function rootOf(port: unknown): string {
  return `http://127.0.0.1:${Number(port)}/`;
}

/** Matches a `listening` event of `version`. */
function listeningAt(version: string) {
  return (event: HotEvent) =>
    event.event === "listening" && event.version === version;
}

/** Fails when the child's stderr shows a bind failure. */
function expectNoBindFailure(child: HotChild) {
  expect(child.stderr()).not.toContain("EADDRINUSE");
  expect(child.stderr()).not.toContain("Failed to start server");
  expect(child.events.filter((event) => event.event === "failed")).toEqual([]);
}

/**
 * Opens a WebSocket (with Bun's `headers` and `protocols` options when given)
 * and resolves it with a queue of the frames it gets.
 */
async function openSocket(
  url: string,
  options?: { headers: Record<string, string>; protocols: string[] },
) {
  const frames: string[] = [];
  const socket =
    options === undefined ? new WebSocket(url) : new WebSocket(url, options);
  socket.addEventListener("message", (event) => {
    frames.push(String(event.data));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`WebSocket to ${url} failed to open`)),
      { once: true },
    );
  });
  return { socket, frames };
}

describe("BunHttpAdapter under bun --hot", () => {
  it(
    "a re-evaluated listen() on the same port reloads the running server: the edited handler answers there, with no EADDRINUSE; close() still releases the port",
    async () => {
      const port = await getPort();
      const child = start(adapterFixture("v1", port));
      await child.waitForEvent(listeningAt("v1"), "v1 listening");
      const url = `http://127.0.0.1:${port}/`;
      expect(await bodyAt(url)).toBe("v1");

      child.rewrite(adapterFixture("v2", port));
      await child.waitUntil(async () => {
        const body = await bodyAt(url);
        return body === "v2" || `answered ${body ?? "nothing"}`;
      }, `v2 answering on port ${port}`);
      const second = await child.waitForEvent(
        listeningAt("v2"),
        "v2 listening",
      );
      expect(second.port).toBe(port);
      expectNoBindFailure(child);

      // close() under --hot: the server stops and the port is free.
      expect(await bodyAt(`${url}close`)).toBe("closing");
      await child.waitForEvent(
        (event) => event.event === "closed" && event.version === "v2",
        "v2 closed",
      );
      await child.waitUntil(async () => {
        const body = await bodyAt(url);
        return body === undefined || `still answered ${body}`;
      }, `port ${port} released after close()`);

      // A closed server is not reused: the next edit binds the port afresh.
      child.rewrite(adapterFixture("v3", port));
      const third = await child.waitForEvent(listeningAt("v3"), "v3 listening");
      expect(third.port).toBe(port);
      expect(await bodyAt(url)).toBe("v3");
      expectNoBindFailure(child);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the edited WebSocket handler answers a new connection and one opened before the edit",
    async () => {
      const port = await getPort();
      const child = start(adapterFixture("v1", port));
      await child.waitForEvent(listeningAt("v1"), "v1 listening");
      const wsUrl = `ws://127.0.0.1:${port}/echo`;

      const early = await openSocket(wsUrl);
      try {
        early.socket.send("before");
        await child.waitUntil(
          async () => early.frames.includes("v1:before") || early.frames.join(),
          "the v1 echo on the early socket",
        );

        child.rewrite(adapterFixture("v2", port));
        await child.waitForEvent(listeningAt("v2"), "v2 listening");
        expectNoBindFailure(child);

        // The socket opened before the edit is still open, and reaches v2.
        expect(early.socket.readyState).toBe(WebSocket.OPEN);
        early.socket.send("after");
        await child.waitUntil(
          async () => early.frames.includes("v2:after") || early.frames.join(),
          "the v2 echo on the socket opened before the edit",
        );

        const late = await openSocket(wsUrl);
        try {
          late.socket.send("new");
          await child.waitUntil(
            async () => late.frames.includes("v2:new") || late.frames.join(),
            "the v2 echo on a new socket",
          );
        } finally {
          late.socket.close();
        }
      } finally {
        early.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a re-evaluated listen(0) keeps the OS-assigned port",
    async () => {
      const child = start(adapterFixture("v1", 0));
      const first = await child.waitForEvent(listeningAt("v1"), "v1 listening");
      const url = `http://127.0.0.1:${first.port}/`;
      expect(await bodyAt(url)).toBe("v1");

      child.rewrite(adapterFixture("v2", 0));
      const second = await child.waitForEvent(
        listeningAt("v2"),
        "v2 listening",
      );
      expect(second.port).toBe(first.port);
      expect(await bodyAt(url)).toBe("v2");
      expectNoBindFailure(child);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "control: with server: { id: null } the re-evaluated listen() fails with EADDRINUSE and the old handler keeps answering",
    async () => {
      const port = await getPort();
      const options = "{ server: { id: null } }";
      const child = start(adapterFixture("v1", port, options));
      await child.waitForEvent(listeningAt("v1"), "v1 listening");
      const url = `http://127.0.0.1:${port}/`;

      child.rewrite(adapterFixture("v2", port, options));
      const failed = await child.waitForEvent(
        (event) => event.event === "failed" && event.version === "v2",
        "v2's listen() to fail",
      );
      expect(failed.code).toBe("EADDRINUSE");
      expect(await bodyAt(url)).toBe("v1");
    },
    TEST_TIMEOUT_MS,
  );
});

/** `devTypes()`, imported by the fixture by absolute path. */
const DEV_TYPES_MODULE = join(PACKAGE_DIR, "lib", "docs", "devTypes.ts");

/**
 * An app with `devTypes()` at `/__bun/types`, at `version`; `v2` adds a
 * route, which moves the documents' hash. Reports `listening` with the
 * port and the dev token.
 */
function devTypesFixture(version: string, port: number): string {
  return `
import { BunHttpAdapter } from ${JSON.stringify(ADAPTER_MODULE)};
import { devTypes } from ${JSON.stringify(DEV_TYPES_MODULE)};
const version = ${JSON.stringify(version)};
const app = new BunHttpAdapter(0);
app.get("/users/:id", (req, res) => {
  res.json({ id: req.params.id });
});
if (version === "v2") {
  app.get("/posts", (_req, res) => {
    res.json([]);
  });
}
const dev = devTypes(app, { enabled: true, tokenFile: false });
app.use(dev);
const server = await app.listen(${port});
console.log(JSON.stringify({ event: "listening", version, port: server.port, token: dev.token }));
`;
}

describe("devTypes() under bun --hot", () => {
  it(
    "a watcher connected before the edit stays connected and gets changed with the edited app's hash; the token is kept",
    async () => {
      const port = await getPort();
      const child = start(devTypesFixture("v1", port));
      const first = await child.waitForEvent(listeningAt("v1"), "v1 listening");
      const token = String(first.token);
      const headers = { authorization: `Bearer ${token}` };

      const watcher = await openSocket(
        `ws://127.0.0.1:${port}/__bun/types/ws`,
        {
          headers,
          protocols: ["bun-types.v1"],
        },
      );
      try {
        const frames = () =>
          watcher.frames.map(
            (frame) =>
              JSON.parse(frame) as {
                type: string;
                data?: { hash?: string };
              },
          );
        await child.waitUntil(
          async () =>
            frames().some((frame) => frame.type === "hello") ||
            watcher.frames.join(),
          "the watcher's hello",
        );
        const hello = frames().find((frame) => frame.type === "hello");

        child.rewrite(devTypesFixture("v2", port));
        const second = await child.waitForEvent(
          listeningAt("v2"),
          "v2 listening",
        );
        expect(second.token).toBe(token);
        expectNoBindFailure(child);
        await child.waitUntil(
          async () =>
            frames().some((frame) => frame.type === "changed") ||
            watcher.frames.join(),
          "a changed frame on the watcher",
        );
        const changed = frames().find((frame) => frame.type === "changed");
        const served = (await (
          await fetch(`http://127.0.0.1:${port}/__bun/types`, { headers })
        ).json()) as { hash: string };
        expect(changed?.data?.hash).toBe(served.hash);
        expect(served.hash).not.toBe(hello?.data?.hash);
      } finally {
        watcher.socket.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("a second listen() on a bound address, with and without --hot", () => {
  /**
   * Two adapters in one evaluation, both on `port`: reports the second
   * `listen()`'s outcome and what the port answers.
   */
  function twoAdapters(port: number): string {
    return `
import { BunHttpAdapter } from ${JSON.stringify(ADAPTER_MODULE)};
const report = (event: string, fields: object = {}) =>
  console.log(JSON.stringify({ event, ...fields }));
const first = new BunHttpAdapter(0);
first.get("/", (_req, res) => {
  res.send("first");
});
const second = new BunHttpAdapter(0);
second.get("/", (_req, res) => {
  res.send("second");
});
await first.listen(${port});
try {
  await second.listen(${port});
  report("second", { outcome: "listening" });
} catch (error) {
  report("second", { outcome: "failed", code: (error as { code?: string }).code });
}
const answer = await (await fetch("http://127.0.0.1:${port}/")).text();
report("answer", { body: answer });
await second.close();
await first.close();
report("done");
`;
  }

  it(
    "without --hot it rejects with EADDRINUSE and the first adapter keeps the port",
    async () => {
      const port = await getPort();
      const child = start(twoAdapters(port), false);
      const second = await child.waitForEvent(
        (event) => event.event === "second",
        "the second listen()",
      );
      expect(second.outcome).toBe("failed");
      expect(second.code).toBe("EADDRINUSE");
      const answer = await child.waitForEvent(
        (event) => event.event === "answer",
        "the answer",
      );
      expect(answer.body).toBe("first");
      expect(await child.exited()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "under --hot the second listen() takes the server over (Bun's server id, oven-sh/bun#7207)",
    async () => {
      const port = await getPort();
      const child = start(twoAdapters(port));
      const second = await child.waitForEvent(
        (event) => event.event === "second",
        "the second listen()",
      );
      expect(second.outcome).toBe("listening");
      const answer = await child.waitForEvent(
        (event) => event.event === "answer",
        "the answer",
      );
      expect(answer.body).toBe("second");
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * Two adapters at `version`, both on port `0` (`app` and `metrics`, each
   * answering `<name>:<version>`), each with a `server.id` of its name when
   * `named`. Reports `listening` with both ports.
   */
  function twoOnPortZero(version: string, named: boolean): string {
    return `
import { BunHttpAdapter } from ${JSON.stringify(ADAPTER_MODULE)};
const version = ${JSON.stringify(version)};
const make = (name: string) => {
  const app = new BunHttpAdapter(0, ${named ? "{ server: { id: name } }" : "{}"});
  app.get("/", (_req, res) => {
    res.send(name + ":" + version);
  });
  return app;
};
const app = await make("app").listen(0);
const metrics = await make("metrics").listen(0);
console.log(JSON.stringify({ event: "listening", version, app: app.port, metrics: metrics.port }));
`;
  }

  it(
    "under --hot two adapters on port 0 share one server, unless each has a server id; named, each keeps its port across an edit",
    async () => {
      const shared = start(twoOnPortZero("v1", false));
      const collapsed = await shared.waitForEvent(
        listeningAt("v1"),
        "v1 listening (unnamed)",
      );
      expect(collapsed.metrics).toBe(collapsed.app);
      expect(await bodyAt(rootOf(collapsed.app))).toBe("metrics:v1");

      const child = start(twoOnPortZero("v1", true));
      const first = await child.waitForEvent(listeningAt("v1"), "v1 listening");
      expect(first.metrics).not.toBe(first.app);
      expect(await bodyAt(rootOf(first.app))).toBe("app:v1");
      expect(await bodyAt(rootOf(first.metrics))).toBe("metrics:v1");

      child.rewrite(twoOnPortZero("v2", true));
      const second = await child.waitForEvent(
        listeningAt("v2"),
        "v2 listening",
      );
      expect(second.app).toBe(first.app);
      expect(second.metrics).toBe(first.metrics);
      expect(await bodyAt(rootOf(first.app))).toBe("app:v2");
      expect(await bodyAt(rootOf(first.metrics))).toBe("metrics:v2");
      expectNoBindFailure(child);
    },
    TEST_TIMEOUT_MS,
  );
});
