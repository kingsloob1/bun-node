/**
 * `live()` (`./query`, typed-client plan `websocket.md` §9, PR-W4) end to
 * end, in one process: a `BunHttpAdapter` on port 0 serving bun-common's
 * `liveInvalidation()` (with a bun-cache cache as a source) and the routes,
 * and the client's query layer over a socket.
 *
 * Covered, each beside its control: a mutation's `cache.invalidates`
 * refetching an observed query (an unobserved one, and one under another
 * tag, untouched); one refetch per invalidation however many of its tags a
 * query holds; refcounted tags (the topic left with the last observer, not
 * the first); a tag from a response's `Cache-Tag`; a bun-cache
 * `invalidateTags()`; resume after a drop (what was missed refetched, and
 * nothing else); a restarted server's epoch invalidating every query; the
 * SSE fallback, asked for and automatic when upgrades are refused; `stop()`;
 * the descriptor agreeing with bun-common's `liveContract`.
 */
import type { Server, ServerWebSocket } from "bun";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { RouteManifest } from "../lib/index";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import {
  liveContract,
  liveInvalidation,
  publishTags,
} from "@kingsleyweb/bun-common/live";
import { restartLiveEpoch } from "@kingsleyweb/bun-common/lib/live/server";
import { QueryClient } from "@tanstack/query-core";
import { afterEach, describe, expect, it } from "bun:test";
import { createClient } from "../lib/index";
import { LIVE_CHANNEL, LIVE_SSE_KEY } from "../lib/live";
import { live, observe, queries } from "../lib/query";

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

interface User {
  id: string;
  name: string;
}

interface Routes {
  "GET /users/:id": {
    params: { id: string };
    responses: { 200: User };
  };
  "GET /users": { responses: { 200: User[] } };
  "GET /orgs/:id": {
    params: { id: string };
    responses: { 200: { id: string } };
  };
  "PATCH /users/:id": {
    params: { id: string };
    body: { name: string };
    responses: { 200: User };
  };
}

const manifest = {
  "GET /users/:id": {
    statuses: [200],
    cache: { tags: ["user:{id}", "users"] },
  },
  "GET /users": { statuses: [200], cache: { tags: ["users"] } },
  "GET /orgs/:id": { statuses: [200] },
  "PATCH /users/:id": {
    statuses: [200],
    cache: { invalidates: ["user:{id}"] },
  },
} as const satisfies RouteManifest<Routes>;

const apps: BunHttpAdapter[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const app of apps.splice(0)) await app.close();
});

/** One app: its server, the requests it saw, its sockets, and its cache. */
async function serve(options: { refuseUpgrades?: boolean } = {}) {
  const { logger } = createTestLogger();
  const adapter = new BunHttpAdapter(0, { logger });
  const hits = new Map<string, number>();
  const users = new Map<string, User>([
    ["1", { id: "1", name: "Ada" }],
    ["2", { id: "2", name: "Grace" }],
  ]);
  const sockets = new Set<ServerWebSocket<unknown>>();
  const cache = createCache({ driver: memoryDriver() });
  adapter.webSocketAdapter.on("open", (ws) => void sockets.add(ws));
  adapter.webSocketAdapter.on("close", (ws) => void sockets.delete(ws));
  if (options.refuseUpgrades)
    // A proxy that does not pass upgrades on.
    adapter.use((req: BunRequest, res: BunResponse, next) => {
      if (req.headersObj.get("upgrade")?.toLowerCase() === "websocket")
        res.status(400).json({ error: "no upgrades here" });
      else next();
    });
  adapter.use(
    liveInvalidation(adapter, {
      authorize: (_req, _res, next) => next(),
      source: cache,
    }),
  );
  const hit = (req: BunRequest) => {
    const key = `${req.method} ${req.path}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
  };
  adapter.get("/users/:id", (req: BunRequest, res: BunResponse) => {
    hit(req);
    res.json(users.get(req.params.id as string));
  });
  adapter.get("/users", (req: BunRequest, res: BunResponse) => {
    hit(req);
    res.json([...users.values()]);
  });
  adapter.get("/orgs/:id", (req: BunRequest, res: BunResponse) => {
    hit(req);
    res.setHeader("Cache-Tag", `org:${req.params.id as string}`);
    res.json({ id: req.params.id });
  });
  adapter
    .patch("/users/:id", (req: BunRequest, res: BunResponse) => {
      hit(req);
      const user = {
        id: req.params.id as string,
        name: (req.body as { name: string }).name,
      };
      users.set(user.id, user);
      res.json(user);
    })
    .describe({ cache: { invalidates: ["user:{id}"] } });
  const server = (await adapter.listen(0)) as Server<unknown>;
  apps.push(adapter);
  return {
    adapter,
    server,
    hits: (key: string) => hits.get(key) ?? 0,
    sockets,
    cache,
    baseUrl: `http://127.0.0.1:${server.port}`,
  };
}

/** A client of `baseUrl` with the query layer and a `QueryClient`, and `live()` started on it. */
function clientOf(baseUrl: string, options?: Parameters<typeof live>[2]) {
  const warnings: unknown[] = [];
  const api = createClient<Routes>({
    baseUrl,
    manifest,
    logger: {
      warn: (...args: unknown[]) => void warnings.push(args),
      error: (...args: unknown[]) => void warnings.push(args),
      debug: () => {},
    },
  });
  const q = queries(api, { manifest });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const stop = live(api, queryClient, options);
  stops.push(stop);
  stops.push(() => queryClient.clear());
  return { api, q, queryClient, stop, warnings };
}

/** Observes `options` until the test ends; resolves once it has data. */
async function watched<T extends { queryKey: unknown }>(
  queryClient: QueryClient,
  options: T,
) {
  const store = observe(queryClient, options as never);
  const off = store.subscribe(() => {});
  stops.push(off);
  await until(
    () => (store.getSnapshot() as { status: string }).status === "success",
  );
  return { store, off };
}

/** The live topic of `tag`, as the server names it. */
const topic = (tag: string) => `bun-common/live:${tag}`;

describe("live(): invalidation over the channel", () => {
  it("refetches an observed query when another client's mutation invalidates its tag", async () => {
    const app = await serve();
    const { q, queryClient } = clientOf(app.baseUrl);
    const one = await watched(
      queryClient,
      q.query("/users/:id", { params: { id: "1" } }),
    );
    await watched(queryClient, q.query("/users/:id", { params: { id: "2" } }));
    // Fetched but never observed: its tag (from its Cache-Tag) is not
    // subscribed, and the list is not touched.
    await queryClient.fetchQuery(q.query("/orgs/:id", { params: { id: "9" } }));
    await queryClient.fetchQuery(q.query("/users"));
    await until(() => app.server.subscriberCount(topic("user:1")) === 1);
    const other = await fetch(`${app.baseUrl}/users/1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada L." }),
    });
    expect(other.status).toBe(200);
    await until(() => app.hits("GET /users/1") === 2);
    await until(
      () =>
        (one.store.getSnapshot() as { data?: User }).data?.name === "Ada L.",
    );
    await Bun.sleep(50);
    // The controls: another user's query, and the unobserved ones.
    expect(app.hits("GET /users/2")).toBe(1);
    expect(app.hits("GET /users")).toBe(1);
    expect(app.server.subscriberCount(topic("org:9"))).toBe(0);
    expect(
      queryClient.getQueryCache().find({ queryKey: q.query("/users").queryKey })
        ?.state.isInvalidated,
    ).toBe(false);
  });

  it("refetches once per invalidation, however many of its tags a query holds", async () => {
    const app = await serve();
    const { q, queryClient } = clientOf(app.baseUrl);
    await watched(queryClient, q.query("/users/:id", { params: { id: "1" } }));
    await until(
      () =>
        app.server.subscriberCount(topic("user:1")) === 1 &&
        app.server.subscriberCount(topic("users")) === 1,
    );
    publishTags(["user:1", "users"]);
    await until(() => app.hits("GET /users/1") === 2);
    await Bun.sleep(80);
    expect(app.hits("GET /users/1")).toBe(2);
  });

  it("refcounts tags: the topic is left with the last observer, not the first", async () => {
    const app = await serve();
    const { q, queryClient } = clientOf(app.baseUrl);
    const one = await watched(
      queryClient,
      q.query("/users/:id", { params: { id: "1" } }),
    );
    const list = await watched(queryClient, q.query("/users"));
    await until(() => app.server.subscriberCount(topic("users")) === 1);
    one.off();
    await until(() => app.server.subscriberCount(topic("user:1")) === 0);
    // `users` is still held by the list.
    expect(app.server.subscriberCount(topic("users"))).toBe(1);
    list.off();
    await until(() => app.server.subscriberCount(topic("users")) === 0);
  });

  it("subscribes to a tag a response's Cache-Tag carries", async () => {
    const app = await serve();
    const { api, queryClient } = clientOf(app.baseUrl);
    const q = queries(api, { manifest });
    await watched(queryClient, q.query("/orgs/:id", { params: { id: "7" } }));
    await until(() => app.server.subscriberCount(topic("org:7")) === 1);
    publishTags(["org:7"]);
    await until(() => app.hits("GET /orgs/7") === 2);
  });

  it("refetches on a bun-cache invalidateTags (the source)", async () => {
    const app = await serve();
    const { q, queryClient } = clientOf(app.baseUrl);
    await watched(queryClient, q.query("/users"));
    await until(() => app.server.subscriberCount(topic("users")) === 1);
    await app.cache.invalidateTags(["users"]);
    await until(() => app.hits("GET /users") === 2);
  });

  it("stops: no subscription and no refetch after stop()", async () => {
    const app = await serve();
    const { q, queryClient, stop } = clientOf(app.baseUrl);
    await watched(queryClient, q.query("/users/:id", { params: { id: "1" } }));
    await until(() => app.server.subscriberCount(topic("user:1")) === 1);
    stop();
    await until(() => app.sockets.size === 0);
    publishTags(["user:1"]);
    await Bun.sleep(80);
    expect(app.hits("GET /users/1")).toBe(1);
  });
});

describe("live(): reconnecting", () => {
  it("resumes after a drop: what it missed is refetched, and nothing else", async () => {
    const app = await serve();
    const { q, queryClient } = clientOf(app.baseUrl);
    await watched(queryClient, q.query("/users/:id", { params: { id: "1" } }));
    await watched(queryClient, q.query("/users/:id", { params: { id: "2" } }));
    await until(() => app.server.subscriberCount(topic("user:1")) === 1);
    for (const ws of app.sockets) ws.close(1001, "going away");
    await until(() => app.server.subscriberCount(topic("user:1")) === 0);
    publishTags(["user:1"]);
    await until(() => app.server.subscriberCount(topic("user:1")) === 1);
    await until(() => app.hits("GET /users/1") === 2);
    await Bun.sleep(50);
    expect(app.hits("GET /users/2")).toBe(1);
  });

  it("invalidates every query when the server's epoch changed (a gap)", async () => {
    const app = await serve();
    const { q, queryClient } = clientOf(app.baseUrl);
    await watched(queryClient, q.query("/users/:id", { params: { id: "1" } }));
    await watched(queryClient, q.query("/orgs/:id", { params: { id: "3" } }));
    await until(() => app.server.subscriberCount(topic("user:1")) === 1);
    restartLiveEpoch();
    for (const ws of app.sockets) ws.close(1001, "restart");
    await until(
      () => app.hits("GET /users/1") === 2 && app.hits("GET /orgs/3") === 2,
    );
  });
});

describe("live(): the SSE fallback", () => {
  it("carries the invalidations over SSE when asked", async () => {
    const app = await serve();
    const { q, queryClient, warnings } = clientOf(app.baseUrl, {
      transport: "sse",
    });
    await watched(queryClient, q.query("/users/:id", { params: { id: "1" } }));
    await watched(queryClient, q.query("/users/:id", { params: { id: "2" } }));
    await Bun.sleep(100);
    expect(app.sockets.size).toBe(0);
    publishTags(["user:2"]);
    await until(() => app.hits("GET /users/2") === 2);
    await Bun.sleep(50);
    expect(app.hits("GET /users/1")).toBe(1);
    expect(warnings).toEqual([]);
  });

  it("moves to SSE on its own when the socket never opens", async () => {
    const app = await serve({ refuseUpgrades: true });
    const { q, queryClient, warnings } = clientOf(app.baseUrl);
    await watched(queryClient, q.query("/users/:id", { params: { id: "1" } }));
    await until(
      () => warnings.some((w) => String((w as unknown[])[0]).includes("SSE")),
      6000,
    );
    await Bun.sleep(100);
    publishTags(["user:1"]);
    await until(() => app.hits("GET /users/1") === 2);
  });
});

describe("the descriptor", () => {
  it("agrees with bun-common's liveContract", () => {
    expect(LIVE_CHANNEL.path).toBe(liveContract.meta.path);
    expect(LIVE_CHANNEL.replies).toEqual({ ...liveContract.meta.replies });
    expect(LIVE_SSE_KEY).toBe(`GET ${liveContract.meta.fallback}`);
    expect(Object.keys(liveContract.spec.receives).sort()).toEqual([
      "resume",
      "subscribe",
      "unsubscribe",
    ]);
    expect(Object.keys(liveContract.spec.sends).sort()).toEqual([
      "gap",
      "hello",
      "invalidate",
    ]);
  });
});
