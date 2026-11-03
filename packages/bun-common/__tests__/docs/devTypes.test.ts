/**
 * `devTypes()` (lib/docs/devTypes.ts, typed-client plan §3.3, §8.3, PR-M2):
 * the dev type sync's server half.
 *
 * - Fail closed: disabled registers nothing; production throws when enabled
 *   and refuses at request time; no token, a wrong token, a non-loopback peer
 *   (unless `allowRemote`), a channel upgrade without the subprotocol — each
 *   answered exactly as a path nothing serves.
 * - The documents are `generateOpenApi`'s and `generateAsyncApi`'s, with
 *   `typesHash`'s hash as the `ETag`; `304` on a match.
 * - Lazy: nothing is generated before the first request, and nothing again
 *   until the route set moves (`routesVersion`).
 * - The channel greets with the hash, answers a ping, and announces a route
 *   change; a second `devTypes()` on the path (a `bun --hot` re-evaluation)
 *   takes over the watchers.
 * - The token file: its contents, mode `0600`, atomic write, removal.
 *
 * Each check is paired with its control: the same request with the one
 * missing ingredient supplied answers `200`/`101`.
 */
import type { Server } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { z } from "zod";
import { BunHttpAdapter } from "../../lib/BunHttpAdapter";
import { BunRouter } from "../../lib/BunRouter";
import { validate } from "../../lib/BunValidate";
import { defineChannel } from "../../lib/channel";
import { generateAsyncApi } from "../../lib/docs/asyncapi";
import { devTypes } from "../../lib/docs/devTypes";
import { typesHash } from "../../lib/docs/hash";
import { generateOpenApi } from "../../lib/docs/openapi";
import { ConfigError } from "../../lib/errors";
import { createTestLogger } from "../../lib/logging";

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(10);
  }
}

/** A unique endpoint path per test, so no two tests share a hub. */
let pathCounter = 0;
function uniquePath(): string {
  pathCounter += 1;
  return `/__dev${pathCounter}/types`;
}

/** A fresh temporary directory for token files, removed after each test. */
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bun-common-devtypes-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The token file template inside this test's scratch directory. */
function tokenFileIn(dir: string): string {
  return join(dir, "cache", "<port>.json");
}

const User = z.object({ id: z.string(), name: z.string() });

/** An app with one validated route, a quiet logger, and no socket. */
function makeRouter(): BunRouter {
  const { logger } = createTestLogger();
  const router = new BunRouter();
  router.setLogger(logger);
  router
    .get(
      "/users/:id",
      validate(
        { params: z.object({ id: z.string() }) },
        { responses: { 200: User } },
      ),
      (req, res) => {
        res.status(200).json({ id: req.params.id, name: "Ada" });
      },
    )
    .describe({ summary: "Read one user" });
  return router;
}

/** A `BunHttpAdapter` with the same route, a quiet logger. */
function makeAdapter(): BunHttpAdapter {
  const { logger } = createTestLogger();
  const adapter = new BunHttpAdapter(0, { logger });
  adapter.get("/users/:id", (req, res) => {
    res.status(200).json({ id: req.params.id });
  });
  return adapter;
}

/** `Authorization: Bearer <token>`. */
function bearer(token: string | undefined): Record<string, string> {
  return { authorization: `Bearer ${String(token)}` };
}

/** Status, headers and body of a response, for "indistinguishable" checks. */
async function shape(response: Response) {
  const headers = [...response.headers].filter(([name]) => name !== "date");
  return { status: response.status, headers, body: await response.text() };
}

/**
 * Sends a WebSocket upgrade over a plain TCP socket with `headers` and
 * returns the status line and headers the server wrote.
 */
async function rawUpgrade(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ statusLine: string; headers: Map<string, string> }> {
  let buffered = "";
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(() => reject(new Error("no response head")), 3000);
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        buffered += chunk.toString("latin1");
        const end = buffered.indexOf("\r\n\r\n");
        if (end !== -1) resolve(buffered.slice(0, end));
      },
      close() {
        reject(new Error(`closed before a response head: ${buffered}`));
      },
      error(_socket, error) {
        reject(error);
      },
    },
  });
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n"),
  );
  try {
    const [statusLine = "", ...lines] = (await promise).split("\r\n");
    return {
      statusLine,
      headers: new Map(
        lines.map((line) => {
          const colon = line.indexOf(":");
          return [
            line.slice(0, colon).trim().toLowerCase(),
            line.slice(colon + 1).trim(),
          ] as [string, string];
        }),
      ),
    };
  } finally {
    clearTimeout(timer);
    socket.end();
  }
}

/** A watcher: a `WebSocket` with the bearer header and the subprotocol, its frames collected. */
async function openWatcher(url: string, token: string | undefined) {
  const client = new WebSocket(url, {
    headers: bearer(token),
    protocols: ["bun-types.v1"],
  });
  const frames: {
    type: string;
    id?: string;
    data?: Record<string, unknown>;
  }[] = [];
  client.onmessage = (event) => {
    frames.push(
      JSON.parse(String(event.data)) as {
        type: string;
        data?: Record<string, unknown>;
      },
    );
  };
  const closed = new Promise<CloseEvent>((resolve) => {
    client.onclose = resolve;
  });
  await new Promise<void>((resolve, reject) => {
    client.onopen = () => resolve();
    client.onerror = () => reject(new Error(`${url} refused the watcher`));
  });
  return { client, frames, closed };
}

/** Runs `body` with `NODE_ENV` set to `value`, restoring it after. */
async function withNodeEnv<T>(
  value: string | undefined,
  body: () => T | Promise<T>,
): Promise<T> {
  const saved = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

/* ------------------------------------------------------------------ */

describe("devTypes(): disabled and production", () => {
  it("registers nothing unless enabled is exactly true (control: enabled serves)", async () => {
    for (const enabled of [false, undefined, "true", 1] as unknown[]) {
      const app = makeRouter();
      const before = app.routesVersion;
      const dev = devTypes(app, { enabled } as { enabled: boolean });
      expect(dev.routes()).toHaveLength(0);
      expect(dev.token).toBeUndefined();
      app.use(dev);
      expect((await app.fetch("/__bun/types")).status).toBe(404);
      // The app gained no channel route either (use() of an empty router
      // registers nothing).
      expect(app.routesVersion).toBe(before);
    }
    const app = makeRouter();
    const dev = devTypes(app, { enabled: true });
    app.use(dev);
    const served = await app.fetch("/__bun/types", {
      headers: bearer(dev.token),
    });
    expect(served.status).toBe(200);
    dev.close();
  });

  it("throws a ConfigError under NODE_ENV=production when enabled (control: development does not)", async () => {
    await withNodeEnv("production", () => {
      expect(() => devTypes(makeRouter(), { enabled: true })).toThrow(
        ConfigError,
      );
      // Disabled under production: nothing, and no throw.
      const dev = devTypes(makeRouter(), { enabled: false });
      expect(dev.routes()).toHaveLength(0);
    });
    await withNodeEnv("development", () => {
      const dev = devTypes(makeRouter(), { enabled: true, path: uniquePath() });
      expect(dev.routes().length).toBeGreaterThan(0);
      dev.close();
    });
  });

  it("refuses at request time once NODE_ENV becomes production (control: back in development it serves)", async () => {
    const app = makeRouter();
    const path = uniquePath();
    const dev = devTypes(app, { enabled: true, path });
    app.use(dev);
    const headers = bearer(dev.token);
    expect((await app.fetch(path, { headers })).status).toBe(200);
    await withNodeEnv("production", async () => {
      const refused = await app.fetch(path, { headers });
      expect(await shape(refused)).toEqual(
        await shape(await app.fetch("/nothing-here")),
      );
    });
    expect((await app.fetch(path, { headers })).status).toBe(200);
    dev.close();
  });

  it("refuses a malformed path or token at construction", () => {
    const app = makeRouter();
    for (const path of ["relative", "/", "/trailing/", "/x/:id", "/x/*"]) {
      expect(() => devTypes(app, { enabled: true, path })).toThrow(ConfigError);
    }
    for (const token of [
      "short",
      "has space in it here",
      "x".repeat(15),
      "bad/slash/in/token/x",
    ]) {
      expect(() =>
        devTypes(app, { enabled: true, path: uniquePath(), token }),
      ).toThrow(ConfigError);
    }
    // Control: a well-formed one is accepted.
    const dev = devTypes(app, {
      enabled: true,
      path: uniquePath(),
      token: "a-good.token_of~16",
    });
    expect(dev.token).toBe("a-good.token_of~16");
    dev.close();
  });
});

describe("devTypes(): the token (socket-free fetch)", () => {
  it("no token, a wrong one, a malformed header: each indistinguishable from an unknown path (control: the token serves)", async () => {
    const app = makeRouter();
    const path = uniquePath();
    const dev = devTypes(app, { enabled: true, path });
    app.use(dev);
    const unknown = await shape(await app.fetch("/nothing-here"));
    expect(unknown.status).toBe(404);
    for (const target of [
      path,
      `${path}/openapi.json`,
      `${path}/asyncapi.json`,
    ]) {
      for (const headers of [
        {},
        bearer("wrong-token-of-enough-length"),
        bearer(`${dev.token}x`),
        { authorization: String(dev.token) },
        { authorization: `Basic ${String(dev.token)}` },
      ]) {
        expect(await shape(await app.fetch(target, { headers }))).toEqual(
          unknown,
        );
      }
      // Control.
      expect(
        (await app.fetch(target, { headers: bearer(dev.token) })).status,
      ).toBe(200);
    }
    // The scheme is case-insensitive.
    expect(
      (
        await app.fetch(path, {
          headers: { authorization: `bearer ${String(dev.token)}` },
        })
      ).status,
    ).toBe(200);
    dev.close();
  });

  it("a refusal reaches the adapter's not-found handler, as an unknown path does", async () => {
    const adapter = makeAdapter();
    adapter.setNotFoundHandler((_req, res) => {
      res.status(404).json({ notFound: true });
    });
    const path = uniquePath();
    const dev = devTypes(adapter, { enabled: true, path, tokenFile: false });
    adapter.use(dev);
    const unknown = await shape(await adapter.fetch("/nothing-here"));
    expect(unknown.body).toBe('{"notFound":true}');
    expect(await shape(await adapter.fetch(path))).toEqual(unknown);
    expect(
      (await adapter.fetch(path, { headers: bearer(dev.token) })).status,
    ).toBe(200);
    dev.close();
  });

  it("a socket-free fetch() has no peer and counts as loopback", async () => {
    const app = makeRouter();
    const path = uniquePath();
    const dev = devTypes(app, { enabled: true, path });
    app.use(dev);
    let peer: unknown = "unset";
    app.use((req, _res, next) => {
      peer = req.socketAddress;
      next();
    });
    await app.fetch("/probe");
    expect(peer).toBeNull();
    expect((await app.fetch(path, { headers: bearer(dev.token) })).status).toBe(
      200,
    );
    dev.close();
  });

  it("a random token per process, 43 base64url characters, unless one is given", () => {
    const app = makeRouter();
    const dev = devTypes(app, { enabled: true, path: uniquePath() });
    expect(dev.token).toMatch(/^[\w-]{43}$/);
    dev.close();
  });
});

describe("devTypes(): the documents", () => {
  it("are generateOpenApi's and generateAsyncApi's, hashed by typesHash, with the dev routes hidden", async () => {
    const app = makeRouter();
    const path = uniquePath();
    const dev = devTypes(app, { enabled: true, path });
    app.use(dev);
    const response = await app.fetch(path, { headers: bearer(dev.token) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      hash: string;
      openapi: Record<string, unknown>;
      asyncapi: Record<string, unknown>;
    };
    const openapi = generateOpenApi(app, {
      title: "API",
      version: "dev",
    }).document;
    const asyncapi = generateAsyncApi(app, {
      title: "API",
      version: "dev",
    }).document;
    expect(body.openapi).toEqual(JSON.parse(JSON.stringify(openapi)));
    expect(body.asyncapi).toEqual(JSON.parse(JSON.stringify(asyncapi)));
    expect(body.hash).toBe(typesHash({ openapi, asyncapi }));
    expect(response.headers.get("etag")).toBe(`"${body.hash}"`);
    // The app's route is there, the dev endpoint is not.
    expect(Object.keys(body.openapi.paths as object)).toEqual(["/users/{id}"]);

    // Each document alone, with the same ETag.
    const one = await app.fetch(`${path}/openapi.json`, {
      headers: bearer(dev.token),
    });
    expect(await one.json()).toEqual(body.openapi);
    expect(one.headers.get("etag")).toBe(`"${body.hash}"`);
    const two = await app.fetch(`${path}/asyncapi.json`, {
      headers: bearer(dev.token),
    });
    expect(await two.json()).toEqual(body.asyncapi);
    dev.close();
  });

  it("takes the generators' options, or functions returning the documents", async () => {
    const app = makeRouter();
    const path = uniquePath();
    const dev = devTypes(app, {
      enabled: true,
      path,
      openapi: { title: "Users", version: "7" },
      asyncapi: () => ({
        asyncapi: "3.0.0",
        info: { title: "Hand", version: "1" },
      }),
    });
    app.use(dev);
    const body = (await (
      await app.fetch(path, { headers: bearer(dev.token) })
    ).json()) as {
      openapi: { info: { title: string; version: string } };
      asyncapi: { info: { title: string } };
    };
    expect(body.openapi.info).toMatchObject({ title: "Users", version: "7" });
    expect(body.asyncapi.info.title).toBe("Hand");
    dev.close();
  });

  it("answers 304 to a matching If-None-Match (control: a stale tag gets 200)", async () => {
    const app = makeRouter();
    const path = uniquePath();
    const dev = devTypes(app, { enabled: true, path });
    app.use(dev);
    const first = await app.fetch(path, { headers: bearer(dev.token) });
    const etag = String(first.headers.get("etag"));
    for (const tag of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const again = await app.fetch(path, {
        headers: { ...bearer(dev.token), "if-none-match": tag },
      });
      expect(again.status).toBe(304);
      expect(again.headers.get("etag")).toBe(etag);
      expect(await again.text()).toBe("");
    }
    const stale = await app.fetch(path, {
      headers: { ...bearer(dev.token), "if-none-match": '"0000000000000000"' },
    });
    expect(stale.status).toBe(200);
    // A refused request never learns the tag.
    const refused = await app.fetch(path, {
      headers: { "if-none-match": etag },
    });
    expect(refused.status).toBe(404);
    expect(refused.headers.get("etag")).toBeNull();
    dev.close();
  });

  it("is built lazily: nothing before the first request, nothing again until the routes change", async () => {
    const app = makeRouter();
    const path = uniquePath();
    let builds = 0;
    const dev = devTypes(app, {
      enabled: true,
      path,
      openapi: () => {
        builds += 1;
        return generateOpenApi(app, { title: "API", version: "dev" }).document;
      },
    });
    app.use(dev);
    dev.listening({ port: 1, hostname: "127.0.0.1" });
    expect(builds).toBe(0);
    // A refused request builds nothing either.
    await app.fetch(path);
    expect(builds).toBe(0);
    const first = await app.fetch(path, { headers: bearer(dev.token) });
    expect(builds).toBe(1);
    await app.fetch(path, { headers: bearer(dev.token) });
    await app.fetch(`${path}/openapi.json`, { headers: bearer(dev.token) });
    expect(builds).toBe(1);
    app.get("/posts", (_req, res) => {
      res.json([]);
    });
    const second = await app.fetch(path, { headers: bearer(dev.token) });
    expect(builds).toBe(2);
    expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
    dev.close();
  });

  it("a describe() after the first request moves the hash", async () => {
    const app = makeRouter();
    const path = uniquePath();
    const dev = devTypes(app, { enabled: true, path });
    app.use(dev);
    const first = (
      await app.fetch(path, { headers: bearer(dev.token) })
    ).headers.get("etag");
    app.get("/late", (_req, res) => {
      res.json({});
    });
    const second = (
      await app.fetch(path, { headers: bearer(dev.token) })
    ).headers.get("etag");
    app.describe({ summary: "Late" });
    const third = (
      await app.fetch(path, { headers: bearer(dev.token) })
    ).headers.get("etag");
    expect(new Set([first, second, third]).size).toBe(3);
    dev.close();
  });

  it("answers 500 without detail when a source throws, and logs it", async () => {
    const { logger, events } = createTestLogger();
    const app = makeRouter();
    app.setLogger(logger);
    const path = uniquePath();
    const dev = devTypes(app, {
      enabled: true,
      path,
      openapi: () => {
        throw new Error("secret detail");
      },
    });
    app.use(dev);
    const response = await app.fetch(path, { headers: bearer(dev.token) });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret detail");
    expect(
      events.some((event) =>
        event.message.includes("building the documents failed"),
      ),
    ).toBe(true);
    dev.close();
  });
});

describe("routesVersion", () => {
  it("BunRouter's moves on a route, a mount and a describe(), and only then", () => {
    const router = new BunRouter();
    const start = router.routesVersion;
    router.get("/a", (_req, res) => {
      void res.end();
    });
    const afterGet = router.routesVersion;
    expect(afterGet).toBeGreaterThan(start);
    router.describe({ summary: "A" });
    const afterDescribe = router.routesVersion;
    expect(afterDescribe).toBeGreaterThan(afterGet);
    const sub = new BunRouter();
    sub.get("/b", (_req, res) => {
      void res.end();
    });
    router.use("/sub", sub);
    expect(router.routesVersion).toBeGreaterThan(afterDescribe);
    // Reading, matching and fetching move nothing.
    const settled = router.routesVersion;
    router.routes();
    router.getMatchedLayers({
      requestHost: "localhost",
      requestMethod: "GET",
      requestUrl: "/a",
    });
    expect(router.routesVersion).toBe(settled);
  });

  it("BunWebSocket's moves on a handler added or removed and a describeChannel()", () => {
    const socket = makeAdapter().getBunWebsocket();
    if (socket === undefined)
      throw new Error("the adapter has no BunWebSocket");
    const start = socket.routesVersion;
    const handler = { message() {} };
    void socket.setRouteHandler("/live", handler);
    const added = socket.routesVersion;
    expect(added).toBeGreaterThan(start);
    // The same handler again: no change.
    void socket.setRouteHandler("/live", handler);
    expect(socket.routesVersion).toBe(added);
    socket.describeChannel("/live", { title: "Live" });
    const described = socket.routesVersion;
    expect(described).toBeGreaterThan(added);
    expect(socket.removeRouteHandler("/live", handler)).toBe(true);
    expect(socket.routesVersion).toBeGreaterThan(described);
    // Removing what is not there: no change.
    const removed = socket.routesVersion;
    expect(socket.removeRouteHandler("/live")).toBe(false);
    expect(socket.routesVersion).toBe(removed);
  });
});

describe("devTypes(): loopback", () => {
  /** An adapter whose requests can be served as if from any peer. */
  class PeerAdapter extends BunHttpAdapter {
    /** Serves `request` as if it came from `address`. */
    fromPeer(request: Request, address: string): Promise<Response | undefined> {
      const server = {
        requestIP: () => ({ address, family: "IPv4", port: 40000 }),
        upgrade: () => false,
        timeout: () => {},
      } as unknown as Server<never>;
      return this.handleNativeRequest(request, server);
    }
  }

  it("refuses a non-loopback peer (control: a loopback peer, and allowRemote)", async () => {
    const { logger } = createTestLogger();
    const adapter = new PeerAdapter(0, { logger });
    const path = uniquePath();
    const dev = devTypes(adapter, { enabled: true, path, tokenFile: false });
    adapter.use(dev);
    const request = () =>
      new Request(`http://localhost${path}`, { headers: bearer(dev.token) });
    for (const address of [
      "203.0.113.9",
      "10.0.0.5",
      "::ffff:192.168.1.4",
      "fe80::1",
    ]) {
      expect((await adapter.fromPeer(request(), address))?.status).toBe(404);
    }
    for (const address of [
      "127.0.0.1",
      "127.0.0.2",
      "::1",
      "::ffff:127.0.0.1",
    ]) {
      expect((await adapter.fromPeer(request(), address))?.status).toBe(200);
    }
    dev.close();

    const remote = new PeerAdapter(0, { logger });
    const remotePath = uniquePath();
    const open = devTypes(remote, {
      enabled: true,
      path: remotePath,
      tokenFile: false,
      allowRemote: true,
    });
    remote.use(open);
    const remoteRequest = (headers: Record<string, string>) =>
      new Request(`http://localhost${remotePath}`, { headers });
    expect(
      (await remote.fromPeer(remoteRequest(bearer(open.token)), "203.0.113.9"))
        ?.status,
    ).toBe(200);
    // allowRemote never waives the token.
    expect(
      (await remote.fromPeer(remoteRequest({}), "203.0.113.9"))?.status,
    ).toBe(404);
    open.close();
  });

  /** A non-loopback IPv4 address of this machine, when it has one. */
  const lan = Object.values(networkInterfaces())
    .flat()
    .find(
      (entry) =>
        entry !== undefined && entry.family === "IPv4" && !entry.internal,
    );

  // Skipped visibly on a machine with no such address (a bare container).
  it.skipIf(lan === undefined)(
    "over a real socket: a non-loopback address of this machine is refused (control: 127.0.0.1)",
    async () => {
      const adapter = makeAdapter();
      const path = uniquePath();
      const dev = devTypes(adapter, { enabled: true, path, tokenFile: false });
      adapter.use(dev);
      const server = await adapter.listen(0, "0.0.0.0");
      try {
        const headers = bearer(dev.token);
        expect(
          (
            await fetch(
              `http://${String(lan?.address)}:${server.port}${path}`,
              {
                headers,
              },
            )
          ).status,
        ).toBe(404);
        expect(
          (await fetch(`http://127.0.0.1:${server.port}${path}`, { headers }))
            .status,
        ).toBe(200);
      } finally {
        await adapter.close();
      }
    },
  );
});

describe("devTypes(): the channel", () => {
  it("greets with the hash, answers a ping, and announces a route change (control: no change, no frame)", async () => {
    const adapter = makeAdapter();
    const path = uniquePath();
    const dev = devTypes(adapter, {
      enabled: true,
      path,
      tokenFile: tokenFileIn(scratch),
    });
    adapter.use(dev);
    const server = await adapter.listen(0);
    try {
      const { client, frames } = await openWatcher(
        `ws://127.0.0.1:${server.port}${path}/ws`,
        dev.token,
      );
      expect(client.protocol).toBe("bun-types.v1");
      await until(() => frames.length >= 1);
      const served = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        headers: bearer(dev.token),
      });
      const { hash } = (await served.json()) as { hash: string };
      expect(frames[0]).toEqual({ type: "hello", data: { version: 1, hash } });

      // Nothing changes: no frame across several polls.
      await Bun.sleep(350);
      expect(frames).toHaveLength(1);

      client.send(JSON.stringify({ type: "ping" }));
      await until(() => frames.length >= 2);
      expect(frames[1]).toEqual({ type: "hello", data: { version: 1, hash } });
      // A ping with an id is answered with it (the channel's `replies`).
      client.send(JSON.stringify({ type: "ping", id: "p-1" }));
      await until(() => frames.length >= 3);
      expect(frames[2]).toEqual({
        type: "hello",
        id: "p-1",
        data: { version: 1, hash },
      });
      frames.splice(2, 1);

      adapter.get("/posts", (_req, res) => {
        res.json([]);
      });
      await until(() => frames.length >= 3);
      const changed = frames[2];
      expect(changed.type).toBe("changed");
      const next = (await (
        await fetch(`http://127.0.0.1:${server.port}${path}`, {
          headers: bearer(dev.token),
        })
      ).json()) as { hash: string };
      expect(changed.data?.hash).toBe(next.hash);
      expect(next.hash).not.toBe(hash);
      expect(typeof changed.data?.at).toBe("number");
      client.close();
    } finally {
      await adapter.close();
    }
  });

  it("a WebSocket route added at run time is announced too", async () => {
    const adapter = makeAdapter();
    const path = uniquePath();
    const dev = devTypes(adapter, { enabled: true, path, tokenFile: false });
    adapter.use(dev);
    const server = await adapter.listen(0);
    try {
      const { client, frames } = await openWatcher(
        `ws://127.0.0.1:${server.port}${path}/ws`,
        dev.token,
      );
      await until(() => frames.length >= 1);
      const chat = defineChannel({
        path: "/chat",
        receives: { say: z.object({ text: z.string() }) },
        sends: {},
      });
      adapter.ws(chat.path, chat.checks(), chat.handler({}), chat.options());
      await until(() => frames.length >= 2);
      expect(frames[1].type).toBe("changed");
      client.close();
    } finally {
      await adapter.close();
    }
  });

  it("refuses an upgrade without the token, with a wrong one, or without the subprotocol (control: header or subprotocol token upgrades)", async () => {
    const adapter = makeAdapter();
    const path = uniquePath();
    const dev = devTypes(adapter, { enabled: true, path, tokenFile: false });
    adapter.use(dev);
    const server = await adapter.listen(0);
    const port = Number(server.port);
    const ws = `${path}/ws`;
    const token = String(dev.token);
    try {
      const unknown = await rawUpgrade(port, "/nothing-here/ws", {
        "Sec-WebSocket-Protocol": "bun-types.v1",
      });
      expect(unknown.statusLine).toBe("HTTP/1.1 404 Not Found");
      const refusals: Record<string, string>[] = [
        { "Sec-WebSocket-Protocol": "bun-types.v1" },
        {
          "Sec-WebSocket-Protocol": "bun-types.v1",
          Authorization: "Bearer wrong-token-of-enough",
        },
        {
          "Sec-WebSocket-Protocol": "bun-types.v1, token.wrong-token-of-enough",
        },
        { Authorization: `Bearer ${token}` },
        { "Sec-WebSocket-Protocol": `token.${token}` },
        {
          "Sec-WebSocket-Protocol": "other.v1",
          Authorization: `Bearer ${token}`,
        },
      ];
      for (const headers of refusals) {
        const head = await rawUpgrade(port, ws, headers);
        expect(head.statusLine).toBe(unknown.statusLine);
        expect(head.headers.get("content-length")).toBe(
          unknown.headers.get("content-length"),
        );
      }
      // Controls: the token as a header, or as a subprotocol beside bun-types.v1.
      const viaHeader = await rawUpgrade(port, ws, {
        "Sec-WebSocket-Protocol": "bun-types.v1",
        Authorization: `Bearer ${token}`,
      });
      expect(viaHeader.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
      const viaProtocol = await rawUpgrade(port, ws, {
        "Sec-WebSocket-Protocol": `bun-types.v1, token.${token}`,
      });
      expect(viaProtocol.statusLine).toBe("HTTP/1.1 101 Switching Protocols");
      // The token is never echoed back.
      expect(viaProtocol.headers.get("sec-websocket-protocol")).toBe(
        "bun-types.v1",
      );
      // A browser-style client, the token as a subprotocol.
      const browser = new WebSocket(`ws://127.0.0.1:${port}${ws}`, [
        "bun-types.v1",
        `token.${token}`,
      ]);
      await new Promise<void>((resolve, reject) => {
        browser.onopen = () => resolve();
        browser.onerror = () => reject(new Error("refused"));
      });
      expect(browser.protocol).toBe("bun-types.v1");
      browser.close();
    } finally {
      await adapter.close();
    }
  });

  it("is hidden from the documents", async () => {
    const adapter = makeAdapter();
    const path = uniquePath();
    const dev = devTypes(adapter, { enabled: true, path, tokenFile: false });
    adapter.use(dev);
    const asyncapi = generateAsyncApi(adapter, {
      title: "API",
      version: "dev",
    }).document;
    expect(JSON.stringify(asyncapi)).not.toContain(path);
    const openapi = generateOpenApi(adapter, {
      title: "API",
      version: "dev",
    }).document;
    expect(JSON.stringify(openapi)).not.toContain(path);
    dev.close();
  });

  it("a second devTypes() on the path (a --hot re-evaluation) keeps the token and announces its documents on the open watchers", async () => {
    const first = makeAdapter();
    const path = uniquePath();
    const dev = devTypes(first, { enabled: true, path, tokenFile: false });
    first.use(dev);
    const server = await first.listen(0);
    try {
      const { frames } = await openWatcher(
        `ws://127.0.0.1:${server.port}${path}/ws`,
        dev.token,
      );
      await until(() => frames.length >= 1);
      const hello = frames[0].data?.hash;

      // The re-evaluated module builds a new app with one more route.
      const second = makeAdapter();
      second.get("/added-on-reload", (_req, res) => {
        res.json({});
      });
      const again = devTypes(second, { enabled: true, path, tokenFile: false });
      second.use(again);
      expect(again.token).toBe(dev.token);
      await until(() => frames.length >= 2);
      expect(frames[1].type).toBe("changed");
      const expected = (await (
        await second.fetch(path, { headers: bearer(again.token) })
      ).json()) as { hash: string };
      expect(frames[1].data?.hash).toBe(expected.hash);
      expect(expected.hash).not.toBe(hello);
      again.close();
    } finally {
      await first.close();
    }
  });

  it("the takeover announces changed as soon as the re-evaluated app listens, without the poll, and only when the hash moved", async () => {
    const first = makeAdapter();
    const path = uniquePath();
    const dev = devTypes(first, { enabled: true, path, tokenFile: false });
    first.use(dev);
    const server = await first.listen(0);
    const second = makeAdapter();
    try {
      const { frames } = await openWatcher(
        `ws://127.0.0.1:${server.port}${path}/ws`,
        dev.token,
      );
      await until(() => frames.length >= 1);

      // Freeze the 100 ms route poll: the hub's timer is swapped for an
      // inert one, which `startPoll` leaves alone and `close()` clears. Any
      // `changed` from here on is the takeover's own.
      const hub = (
        globalThis as unknown as Record<
          symbol,
          {
            hubs: Map<
              string,
              { timer: ReturnType<typeof setInterval> | undefined }
            >;
          }
        >
      )[Symbol.for("@kingsleyweb/bun-common/devTypes")].hubs.get(path);
      if (hub === undefined) throw new Error("no hub for the path");
      clearInterval(hub.timer);
      hub.timer = setInterval(() => {}, 2 ** 30);
      hub.timer.unref();

      second.get("/added-on-reload", (_req, res) => {
        res.json({});
      });
      const again = devTypes(second, { enabled: true, path, tokenFile: false });
      second.use(again);
      // Not before the app is complete: several poll periods pass silently.
      await Bun.sleep(350);
      expect(frames.length).toBe(1);

      await second.listen(0);
      await until(() => frames.length >= 2, 2000);
      expect(frames[1].type).toBe("changed");
      const expected = (await (
        await second.fetch(path, { headers: bearer(again.token) })
      ).json()) as { hash: string };
      expect(frames[1].data?.hash).toBe(expected.hash);

      // Listening again with nothing moved announces nothing.
      const bound = second.getBunServer();
      if (bound === undefined) throw new Error("second is not listening");
      again.listening(bound);
      await Bun.sleep(200);
      expect(frames.length).toBe(2);
      again.close();
    } finally {
      await second.close();
      await first.close();
    }
  });

  it("close() closes the watchers with 1001", async () => {
    const adapter = makeAdapter();
    const path = uniquePath();
    const dev = devTypes(adapter, { enabled: true, path, tokenFile: false });
    adapter.use(dev);
    const server = await adapter.listen(0);
    try {
      const { closed, frames } = await openWatcher(
        `ws://127.0.0.1:${server.port}${path}/ws`,
        dev.token,
      );
      await until(() => frames.length >= 1);
      dev.close();
      expect((await closed).code).toBe(1001);
    } finally {
      await adapter.close();
    }
  });

  it("a router without a BunWebSocket serves HTTP only, and says so", async () => {
    const { logger, events } = createTestLogger();
    const app = new BunRouter();
    app.setLogger(logger);
    const path = uniquePath();
    const dev = devTypes(app, { enabled: true, path });
    app.use(dev);
    expect(
      events.some(
        (event) =>
          event.level === "warn" && event.message.includes("no BunWebSocket"),
      ),
    ).toBe(true);
    expect((await app.fetch(path, { headers: bearer(dev.token) })).status).toBe(
      200,
    );
    dev.close();
  });
});

describe("devTypes(): the token file", () => {
  it("is written on listen with the URL, ws URL, token and pid, mode 0600 in a 0700 directory, atomically; removed on close", async () => {
    const adapter = makeAdapter();
    const path = uniquePath();
    const dev = devTypes(adapter, {
      enabled: true,
      path,
      tokenFile: tokenFileIn(scratch),
    });
    adapter.use(dev);
    expect(dev.tokenFile).toBeUndefined();
    const server = await adapter.listen(0);
    const file = join(scratch, "cache", `${server.port}.json`);
    expect(dev.tokenFile).toBe(file);
    const content = (await Bun.file(file).json()) as Record<string, unknown>;
    expect(content).toEqual({
      url: `http://127.0.0.1:${server.port}${path}`,
      ws: `ws://127.0.0.1:${server.port}${path}/ws`,
      token: dev.token,
      pid: process.pid,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(scratch, "cache")).mode & 0o777).toBe(0o700);
    // Atomic: the temporary file was renamed, nothing else is left.
    expect(readdirSync(join(scratch, "cache"))).toEqual([
      `${server.port}.json`,
    ]);
    // The URL in it works with the token in it.
    const served = await fetch(String(content.url), {
      headers: bearer(String(content.token)),
    });
    expect(served.status).toBe(200);
    await adapter.close();
    expect(await Bun.file(file).exists()).toBe(false);
    expect(dev.tokenFile).toBeUndefined();
  });

  it("defaults to node_modules/.cache/bun-types/<port>.json under the working directory", async () => {
    const saved = process.cwd();
    process.chdir(scratch);
    const adapter = makeAdapter();
    const dev = devTypes(adapter, { enabled: true, path: uniquePath() });
    adapter.use(dev);
    try {
      const server = await adapter.listen(0);
      expect(dev.tokenFile).toBe(
        join(
          scratch,
          "node_modules",
          ".cache",
          "bun-types",
          `${server.port}.json`,
        ),
      );
      expect(await Bun.file(String(dev.tokenFile)).exists()).toBe(true);
    } finally {
      await adapter.close();
      process.chdir(saved);
    }
  });

  it("leaves a file that another server's token replaced (control: its own is removed)", async () => {
    const adapter = makeAdapter();
    const dev = devTypes(adapter, {
      enabled: true,
      path: uniquePath(),
      tokenFile: tokenFileIn(scratch),
    });
    adapter.use(dev);
    await adapter.listen(0);
    const file = String(dev.tokenFile);
    writeFileSync(file, JSON.stringify({ token: "someone-else-entirely" }));
    await adapter.close();
    expect(await Bun.file(file).exists()).toBe(true);
  });

  it("tokenFile: false writes none; a bare router writes on listening(server)", async () => {
    const adapter = makeAdapter();
    const off = devTypes(adapter, {
      enabled: true,
      path: uniquePath(),
      tokenFile: false,
    });
    adapter.use(off);
    await adapter.listen(0);
    expect(off.tokenFile).toBeUndefined();
    await adapter.close();

    const app = makeRouter();
    const dev = devTypes(app, {
      enabled: true,
      path: uniquePath(),
      tokenFile: tokenFileIn(scratch),
    });
    app.use(dev);
    const server = Bun.serve({
      port: 0,
      hostname: "0.0.0.0",
      fetch: () => new Response(""),
    });
    try {
      dev.listening(server);
      const content = (await Bun.file(String(dev.tokenFile)).json()) as {
        url: string;
      };
      // A wildcard listener is dialled on loopback.
      expect(content.url.startsWith(`http://127.0.0.1:${server.port}/`)).toBe(
        true,
      );
      // No port (a unix socket): no file.
      dev.close();
      dev.listening({ port: undefined });
      expect(dev.tokenFile).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });
});

describe("devTypes(): the token file and signals", () => {
  const FIXTURE = join(import.meta.dir, "fixtures/devTypes.signal.fixture.ts");

  /** Starts the fixture, resolves once it printed its `ready` line. */
  async function start(mode: string) {
    const child = Bun.spawn([process.execPath, FIXTURE], {
      env: {
        ...process.env,
        MODE: mode,
        TOKEN_FILE: join(scratch, "sig", "<port>.json"),
      },
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = child.stdout.getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`fixture exited early: ${text}`);
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const [, file, listeners] = text.trim().split(" ");
    return { child, file, listeners: Number(listeners) };
  }

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    it(`${signal} removes the token file and the process still exits ${code}`, async () => {
      const { child, file } = await start("plain");
      try {
        expect(await Bun.file(file).exists()).toBe(true);
        child.kill(signal);
        expect(await child.exited).toBe(code);
        expect(await Bun.file(file).exists()).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    });
  }

  it("control: SIGKILL (no hook can run) leaves the file, so the checks above are the hook's doing", async () => {
    const { child, file } = await start("plain");
    child.kill("SIGKILL");
    await child.exited;
    expect(await Bun.file(file).exists()).toBe(true);
  });

  it("an app with its own SIGTERM listener decides: it runs, exits 7, and the exit hook removes the file", async () => {
    const { child, file } = await start("own");
    try {
      expect(await Bun.file(file).exists()).toBe(true);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(7);
      expect(await Bun.file(file).exists()).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("installs no signal listener when no token file is written", async () => {
    const written = await start("plain");
    const none = await start("nofile");
    try {
      // The app's own listener count: the hook's one, or none.
      expect(written.listeners).toBe(1);
      expect(none.listeners).toBe(0);
      expect(none.file).toBe("-");
    } finally {
      written.child.kill("SIGKILL");
      none.child.kill("SIGKILL");
    }
  });

  it("close() removes the listeners it installed", async () => {
    const before = process.listenerCount("SIGTERM");
    const adapter = makeAdapter();
    const dev = devTypes(adapter, {
      enabled: true,
      path: uniquePath(),
      tokenFile: tokenFileIn(scratch),
    });
    adapter.use(dev);
    await adapter.listen(0);
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
    await adapter.close();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("bun-common resolves @routejs/router from its own directory", () => {
  /** Imports BunRouter in a child whose working directory is `cwd`. */
  async function importIn(cwd: string) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-install",
        "-e",
        `const m = await import(${JSON.stringify(join(import.meta.dir, "../../lib/BunRouter.ts"))}); console.log(typeof m.BunRouter);`,
      ],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out: out.trim(), err, code };
  }

  it("loads from a working directory with no node_modules above it, and from one with an empty node_modules (what devTypes() creates)", async () => {
    // The scratch directory is under the OS temp dir: no node_modules above it.
    const bare = await importIn(scratch);
    expect(bare).toMatchObject({ out: "function", code: 0 });
    const empty = join(scratch, "empty-cwd");
    mkdirSync(join(empty, "node_modules/.cache"), { recursive: true });
    expect(await importIn(empty)).toMatchObject({ out: "function", code: 0 });
  });
});
