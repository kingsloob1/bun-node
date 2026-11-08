/**
 * The query layer (`./query`, plan §6.3, §6.4, §12.1's PR-C5 row) against a
 * real bun-common router: through `router.fetch()`, and through `Bun.serve`
 * on port 0 for the ETag round trip over a socket. Keys and prefix
 * invalidation; declared tag templates; `Cache-Tag` and `Surrogate-Key`
 * headers (bun-cache's `cacheResponse({ surrogateKeys })`); `invalidates`;
 * ETag and 304 keeping the data's identity; optimistic writes and their
 * rollback; infinite pages; `observe()` and its unsubscribe. Each behaviour
 * has a negative control beside it: the same setup without the cause, which
 * must not show the effect.
 */
import type { RouteManifest } from "../lib/index";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { QueryKey } from "@tanstack/query-core";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { addCacheTags, cacheResponse } from "@kingsleyweb/bun-cache/http";
import { BunRouter } from "@kingsleyweb/bun-common";
import { hashKey, MutationObserver, QueryClient } from "@tanstack/query-core";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { createClient, HttpError } from "../lib/index";
import { invalidateTags, observe, queries, tagsOfQuery } from "../lib/query";

interface User {
  id: string;
  name: string;
}

interface Page {
  items: User[];
  next: number | null;
}

interface Routes {
  "GET /users/:id": {
    params: { id: string };
    query: { expand?: string[] };
    body: undefined;
    responses: { 200: User; 404: { code: "NOT_FOUND" } };
  };
  "GET /users": {
    params: Record<never, never>;
    query: { q?: string; page?: number };
    body: undefined;
    responses: { 200: Page };
  };
  "POST /users": {
    params: Record<never, never>;
    query: Record<never, never>;
    body: { name: string };
    responses: { 201: User };
  };
  "PATCH /users/:id": {
    params: { id: string };
    query: Record<never, never>;
    body: { name: string; fail?: boolean };
    responses: { 200: User; 409: { code: "CONFLICT" } };
  };
  "GET /volatile/:id": {
    params: { id: string };
    responses: { 200: User };
  };
  "GET /orgs/:id": {
    params: { id: string };
    responses: { 200: { id: string; team: string } };
  };
  "GET /cdn/:id": {
    params: { id: string };
    responses: { 200: { id: string } };
  };
}

const manifest = {
  "GET /users/:id": {
    statuses: [200, 404],
    cache: { tags: ["user:{id}", "users"] },
  },
  "GET /users": { statuses: [200], cache: { tags: ["users"] } },
  "POST /users": { statuses: [201], cache: { invalidates: ["users"] } },
  "PATCH /users/:id": {
    statuses: [200, 409],
    cache: { invalidates: ["user:{id}"] },
  },
  "GET /orgs/:id": { cache: { tags: ["org-doc:{missing}"] } },
} as const satisfies RouteManifest<Routes>;

/** The server's state, reset before each test. */
const state = {
  users: new Map<string, User>(),
  /** Requests seen, by `"METHOD /path"` (the URL's path). */
  hits: new Map<string, number>(),
  /** `If-None-Match` values seen, in order (`null`: none). */
  conditions: [] as (string | null)[],
  /** Holds a PATCH until released, so a test can look at the cache mid-flight. */
  hold: undefined as Promise<void> | undefined,
};

/** Counts a request. */
function hit(req: BunRequest): void {
  const key = `${req.method} ${req.path}`;
  state.hits.set(key, (state.hits.get(key) ?? 0) + 1);
}

/** How many times `key` was requested. */
const hits = (key: string): number => state.hits.get(key) ?? 0;

const cache = createCache({ driver: memoryDriver() });
const router = new BunRouter();

router.get("/users/:id", (req: BunRequest, res: BunResponse) => {
  hit(req);
  state.conditions.push(req.get("if-none-match") ?? null);
  const user = state.users.get(req.params.id as string);
  if (!user) {
    res.status(404).json({ code: "NOT_FOUND" });
    return;
  }
  res.setEtag(true);
  res.json(user);
});
router.get("/users", (req: BunRequest, res: BunResponse) => {
  hit(req);
  const page = Number((req.query as { page?: string }).page ?? "1");
  const q = (req.query as { q?: string }).q ?? "";
  const all = [...state.users.values()]
    .filter((user) => user.name.toLowerCase().includes(q))
    .sort((a, b) => a.id.localeCompare(b.id));
  const items = all.slice((page - 1) * 2, page * 2);
  res.json({ items, next: page * 2 < all.length ? page + 1 : null });
});
router.post("/users", (req: BunRequest, res: BunResponse) => {
  hit(req);
  const id = String(state.users.size + 1);
  const user = { id, name: (req.body as { name: string }).name };
  state.users.set(id, user);
  res.status(201).json(user);
});
router.patch("/users/:id", async (req: BunRequest, res: BunResponse) => {
  hit(req);
  await state.hold;
  const body = req.body as { name: string; fail?: boolean };
  if (body.fail) {
    res.status(409).json({ code: "CONFLICT" });
    return;
  }
  const user = { id: req.params.id as string, name: body.name };
  state.users.set(user.id, user);
  res.json(user);
});
router.get("/volatile/:id", (req: BunRequest, res: BunResponse) => {
  hit(req);
  state.conditions.push(req.get("if-none-match") ?? null);
  res.setEtag(true);
  res.setHeader("cache-control", "no-store");
  res.json(state.users.get(req.params.id as string));
});
router.get(
  "/orgs/:id",
  cacheResponse(cache, { ttl: 60_000, surrogateKeys: "Surrogate-Key" }),
  (req: BunRequest, res: BunResponse) => {
    hit(req);
    // A tag the route cannot declare: it comes from the data.
    addCacheTags(res, `org:${req.params.id as string}`, "team:blue");
    res.json({ id: req.params.id, team: "blue" });
  },
);
router.get("/cdn/:id", (req: BunRequest, res: BunResponse) => {
  hit(req);
  res.setHeader("cache-tag", ` cdn:${req.params.id as string} , shared,,`);
  res.json({ id: req.params.id });
});

/** Requests sent, by route key, at the client's fetch (bun-cache's hits included). */
const sent = new Map<string, number>();

/** A client over the router, in process; `withManifest: false` drops the statuses and tags. */
function makeApi(withManifest = true) {
  return createClient<Routes>({
    baseUrl: "http://localhost",
    fetch: (request) => {
      const key = `${request.method} ${new URL(request.url).pathname}`;
      sent.set(key, (sent.get(key) ?? 0) + 1);
      return router.fetch(request);
    },
    retry: false,
    ...(withManifest ? { manifest } : {}),
  });
}

const api = makeApi();
const q = queries(api, { manifest });

/** A client that retries nothing: a failure is a failure. */
const newQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

/**
 * A query's cached data, as `unknown`: `getQueryData` infers its result from
 * the context it is called in, and `expect()`'s would make it `undefined`.
 */
const dataOf = (client: QueryClient, key: QueryKey): unknown =>
  client.getQueryData(key);

/** Waits for the fetches a subscription started, through the in-process router, to settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(async () => {
  state.users = new Map([
    ["1", { id: "1", name: "Ada" }],
    ["2", { id: "2", name: "Alan" }],
    ["3", { id: "3", name: "Grace" }],
  ]);
  state.hits.clear();
  state.conditions = [];
  state.hold = undefined;
  sent.clear();
  await cache.clear();
});

afterAll(async () => {
  await cache.close();
});

describe("keys (§6.4)", () => {
  it("are [routeKey, { params, query }], params written as strings", () => {
    const options = q.query("/users/:id", {
      params: { id: "7" },
      query: { expand: ["org"] },
    });
    expect(options.queryKey as QueryKey).toEqual([
      "GET /users/:id",
      { params: { id: "7" }, query: { expand: ["org"] } },
    ]);
    expect(q.query("/users/:id", { params: { id: "7" } }).queryKey).toEqual(
      q.query("/users/:id", { params: { id: 7 as unknown as string } })
        .queryKey,
    );
  });

  it("are stable: the same call hashes the same, whatever the order of the query's keys", () => {
    const a = q.query("/users", { query: { q: "a", page: 2 } }).queryKey;
    const b = q.query("/users", { query: { page: 2, q: "a" } }).queryKey;
    expect(hashKey(a)).toBe(hashKey(b));
    // Control: a different value is a different key.
    expect(hashKey(a)).not.toBe(
      hashKey(q.query("/users", { query: { q: "b", page: 2 } }).queryKey),
    );
  });

  it("invalidate by prefix: q.key(routeKey) reaches every query of the route, and no other", async () => {
    const client = newQueryClient();
    await client.fetchQuery(q.query("/users/:id", { params: { id: "1" } }));
    await client.fetchQuery(q.query("/users/:id", { params: { id: "2" } }));
    await client.fetchQuery(q.query("/users"));
    await client.invalidateQueries({ queryKey: q.key("GET /users/:id") });
    const invalidated = client
      .getQueryCache()
      .getAll()
      .map((query) => [query.queryKey[0], query.state.isInvalidated]);
    expect(invalidated).toEqual([
      ["GET /users/:id", true],
      ["GET /users/:id", true],
      ["GET /users", false],
    ]);
  });

  it("invalidate by a partial key: { params } reaches that user's queries only", async () => {
    const client = newQueryClient();
    await client.fetchQuery(q.query("/users/:id", { params: { id: "1" } }));
    await client.fetchQuery(
      q.query("/users/:id", { params: { id: "1" }, query: { expand: ["x"] } }),
    );
    await client.fetchQuery(q.query("/users/:id", { params: { id: "2" } }));
    await client.invalidateQueries({
      queryKey: q.key("GET /users/:id", { params: { id: 1 } }),
    });
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.isInvalidated),
    ).toEqual([true, true, false]);
  });

  it("a query's data reads back through its key", async () => {
    const client = newQueryClient();
    const options = q.query("/users/:id", { params: { id: "1" } });
    await client.fetchQuery(options);
    expect(dataOf(client, options.queryKey)).toEqual({
      id: "1",
      name: "Ada",
    });
  });
});

describe("declared tags (§6.4, D13)", () => {
  it("fills the manifest's templates from the params into meta.tags", () => {
    expect(q.query("/users/:id", { params: { id: "7" } }).meta).toEqual({
      tags: ["user:7", "users"],
    });
    expect(q.query("/users").meta).toEqual({ tags: ["users"] });
  });

  it("leaves out a template naming a param the call does not have", () => {
    expect(q.query("/orgs/:id", { params: { id: "7" } }).meta).toEqual({
      tags: [],
    });
  });

  it("control: without the manifest, no route declares a tag", () => {
    const bare = queries(api);
    expect(bare.query("/users/:id", { params: { id: "7" } }).meta).toEqual({
      tags: [],
    });
  });

  it("invalidateTags refetches the active queries carrying a tag, and only those", async () => {
    const client = newQueryClient();
    const one = observe(client, q.query("/users/:id", { params: { id: "1" } }));
    const two = observe(client, q.query("/users/:id", { params: { id: "2" } }));
    const stops = [one.subscribe(() => {}), two.subscribe(() => {})];
    await tick();
    expect(hits("GET /users/1")).toBe(1);
    expect(hits("GET /users/2")).toBe(1);

    await invalidateTags(client, ["user:1"]);
    expect(hits("GET /users/1")).toBe(2);
    expect(hits("GET /users/2")).toBe(1);

    // A tag both carry.
    await q.invalidateTags(client, ["users"]);
    expect(hits("GET /users/1")).toBe(3);
    expect(hits("GET /users/2")).toBe(2);

    // Control: a tag nobody carries refetches nothing.
    await invalidateTags(client, ["user:9", "User:1"]);
    expect(hits("GET /users/1")).toBe(3);
    expect(hits("GET /users/2")).toBe(2);
    for (const stop of stops) stop();
  });
});

describe("tags from the response's headers (§6.4, Q12)", () => {
  it("keeps bun-cache's Surrogate-Key tags, the data's own included, beside the declared ones", async () => {
    const client = newQueryClient();
    const options = q.query("/orgs/:id", { params: { id: "7" } });
    await client.fetchQuery(options);
    const query = client.getQueryCache().find({ queryKey: options.queryKey })!;
    expect(tagsOfQuery(client, query).sort()).toEqual([
      "http:path:/orgs/7",
      "org:7",
      "team:blue",
    ]);
  });

  it("invalidates a query by a tag only its response named", async () => {
    const client = newQueryClient();
    const seven = observe(
      client,
      q.query("/orgs/:id", { params: { id: "7" } }),
    );
    const eight = observe(
      client,
      q.query("/orgs/:id", { params: { id: "8" } }),
    );
    const stops = [seven.subscribe(() => {}), eight.subscribe(() => {})];
    await tick();
    expect(sent.get("GET /orgs/7")).toBe(1);

    await invalidateTags(client, ["org:7"]);
    expect(sent.get("GET /orgs/7")).toBe(2);
    expect(sent.get("GET /orgs/8")).toBe(1);

    // A data-driven tag both answers carried.
    await invalidateTags(client, ["team:blue"]);
    expect(sent.get("GET /orgs/7")).toBe(3);
    expect(sent.get("GET /orgs/8")).toBe(2);

    // Control: an org no answer named.
    await invalidateTags(client, ["org:9"]);
    expect(sent.get("GET /orgs/7")).toBe(3);
    expect(sent.get("GET /orgs/8")).toBe(2);
    for (const stop of stops) stop();
  });

  it("reads Cache-Tag as a comma-separated list, trimmed, empty items dropped", async () => {
    const client = newQueryClient();
    const options = q.query("/cdn/:id", { params: { id: "4" } });
    await client.fetchQuery(options);
    const query = client.getQueryCache().find({ queryKey: options.queryKey })!;
    expect(tagsOfQuery(client, query)).toEqual(["cdn:4", "shared"]);
  });

  it("control: a route sending no tag header carries only its declared tags", async () => {
    const client = newQueryClient();
    const options = q.query("/users/:id", { params: { id: "1" } });
    await client.fetchQuery(options);
    const query = client.getQueryCache().find({ queryKey: options.queryKey })!;
    expect(tagsOfQuery(client, query)).toEqual(["user:1", "users"]);
  });

  it("forgets a query's header tags when the cache removes it", async () => {
    const client = newQueryClient();
    const options = q.query("/cdn/:id", { params: { id: "4" } });
    await client.fetchQuery(options);
    const query = client.getQueryCache().find({ queryKey: options.queryKey })!;
    client.removeQueries({ queryKey: options.queryKey });
    expect(tagsOfQuery(client, query)).toEqual([]);
  });
});

describe("ETag and 304 (§6.4, D14)", () => {
  it("sends the last ETag as If-None-Match and keeps the cached object on a 304", async () => {
    const client = newQueryClient();
    const options = {
      ...q.query("/users/:id", { params: { id: "1" } }),
      // Off, so identity is the 304's doing and not structural sharing's.
      structuralSharing: false,
    };
    const first = await client.fetchQuery(options);
    const before = client.getQueryState(options.queryKey)!.dataUpdatedAt;
    await Bun.sleep(2);
    const again = await client.fetchQuery({ ...options, staleTime: 0 });
    expect(state.conditions).toEqual([null, expect.stringMatching(/^"/)]);
    expect(again).toBe(first);
    expect(dataOf(client, options.queryKey)).toBe(first);
    // The data was confirmed, so it is as fresh as a new answer.
    expect(
      client.getQueryState(options.queryKey)!.dataUpdatedAt,
    ).toBeGreaterThan(before);
  });

  it("control: a changed resource answers 200, and the new data replaces the old", async () => {
    const client = newQueryClient();
    const options = {
      ...q.query("/users/:id", { params: { id: "1" } }),
      structuralSharing: false,
    };
    const first = await client.fetchQuery(options);
    state.users.set("1", { id: "1", name: "Ada L." });
    const again = await client.fetchQuery({ ...options, staleTime: 0 });
    expect(state.conditions[1]).toMatch(/^"/);
    expect(again).not.toBe(first);
    expect(again).toEqual({ id: "1", name: "Ada L." });
    // Its new ETag is the one sent next.
    state.conditions = [];
    const third = await client.fetchQuery({ ...options, staleTime: 0 });
    expect(third).toBe(again);
  });

  it("handles the 304 the same without a manifest (the client reads it as an HttpError there)", async () => {
    const bare = queries(makeApi(false));
    const client = newQueryClient();
    const options = {
      ...bare.query("/users/:id", { params: { id: "2" } }),
      structuralSharing: false,
    };
    const first = await client.fetchQuery(options);
    const again = await client.fetchQuery({ ...options, staleTime: 0 });
    expect(again).toBe(first);
    expect(state.conditions).toEqual([null, expect.stringMatching(/^"/)]);
  });

  it("over a socket: Bun.serve on port 0, the browser's fetch path", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: (request) => router.fetch(request),
    });
    const remote = queries(
      createClient<Routes>({
        baseUrl: server.url.origin,
        manifest,
        retry: false,
      }),
      { manifest },
    );
    const client = newQueryClient();
    const options = {
      ...remote.query("/users/:id", { params: { id: "3" } }),
      structuralSharing: false,
    };
    const first = await client.fetchQuery(options);
    const again = await client.fetchQuery({ ...options, staleTime: 0 });
    expect(again).toBe(first);
    expect(state.conditions).toEqual([null, expect.stringMatching(/^"/)]);
  });

  it("drops the ETag when the data is written by hand, so the next fetch is unconditional", async () => {
    const client = newQueryClient();
    const options = q.query("/users/:id", { params: { id: "1" } });
    await client.fetchQuery(options);
    client.setQueryData(options.queryKey, { id: "1", name: "local" });
    const again = await client.fetchQuery({ ...options, staleTime: 0 });
    expect(state.conditions).toEqual([null, null]);
    // The server's data, not the local write a 304 would have kept.
    expect(again).toEqual({ id: "1", name: "Ada" });
  });

  it("keeps no ETag for a Cache-Control: no-store answer", async () => {
    const client = newQueryClient();
    const options = q.query("/volatile/:id", { params: { id: "1" } });
    await client.fetchQuery(options);
    await client.fetchQuery({ ...options, staleTime: 0 });
    expect(state.conditions).toEqual([null, null]);
  });

  it("sends no condition once the cache removed the query (its data is gone)", async () => {
    const client = newQueryClient();
    const options = q.query("/users/:id", { params: { id: "1" } });
    await client.fetchQuery(options);
    client.removeQueries({ queryKey: options.queryKey });
    const again = await client.fetchQuery(options);
    expect(again).toEqual({ id: "1", name: "Ada" });
    expect(state.conditions).toEqual([null, null]);
  });

  it("a declared error status still fails the query, with the client's HttpError", async () => {
    const client = newQueryClient();
    const failure = await client
      .fetchQuery(q.query("/users/:id", { params: { id: "9" } }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(404);
  });
});

describe("BYO response schemas (§5.4)", () => {
  /** A BYO schema that transforms, so its output is told from the wire's. */
  const Shouted = z.object({
    id: z.string(),
    name: z.string().transform((name) => name.toUpperCase()),
  });

  it("q.query delivers (and caches) a BYO schema's output for the status it is set for (control: without it, the wire body)", async () => {
    const client = newQueryClient();
    const shouted = q.query("/users/:id", {
      params: { id: "1" },
      validate: { response: { 200: { custom: Shouted } } },
    });
    const fetched = await client.fetchQuery(shouted);
    expect(fetched.name).toBe("ADA");
    expect(dataOf(client, shouted.queryKey)).toEqual({ id: "1", name: "ADA" });
    const plain = await newQueryClient().fetchQuery(
      q.query("/users/:id", { params: { id: "1" } }),
    );
    expect(plain.name).toBe("Ada");
  });

  it("q.infinite delivers each page as the schema's output", async () => {
    const client = newQueryClient();
    const pages = await client.fetchInfiniteQuery(
      q.infinite(
        "/users",
        {
          validate: {
            response: {
              200: {
                custom: z.object({
                  items: z.array(Shouted),
                  next: z.number().nullable(),
                }),
              },
            },
          },
        },
        { pageParam: "page", next: (last) => last.next },
      ),
    );
    expect(pages.pages[0]?.items.map((user) => user.name)).toEqual(
      expect.arrayContaining(["ADA"]),
    );
  });

  it("q.mutation's validate applies to every call (control: variables carrying their own validate use it instead)", async () => {
    const client = newQueryClient();
    const created = new MutationObserver(
      client,
      q.mutation("POST /users", {
        validate: { response: { 201: { custom: Shouted } } },
      }),
    );
    const data = await created.mutate({ body: { name: "Barbara" } });
    expect(data.name).toBe("BARBARA");
    const raw = await created.mutate({
      body: { name: "Edsger" },
      validate: false,
    });
    expect(raw.name).toBe("Edsger");
  });
});

describe("invalidates (§6.4)", () => {
  it("a mutation invalidates its route's tags, filled from its params, before it resolves", async () => {
    const client = newQueryClient();
    const stops = [
      observe(client, q.query("/users/:id", { params: { id: "1" } })).subscribe(
        () => {},
      ),
      observe(client, q.query("/users/:id", { params: { id: "2" } })).subscribe(
        () => {},
      ),
    ];
    await tick();
    const rename = new MutationObserver(client, q.mutation("PATCH /users/:id"));
    expect(q.mutation("PATCH /users/:id").meta).toEqual({
      invalidates: ["user:{id}"],
    });
    await rename.mutate({ params: { id: "1" }, body: { name: "Ada L." } });
    expect(hits("GET /users/1")).toBe(2);
    // Control: user 2 shares no invalidated tag.
    expect(hits("GET /users/2")).toBe(1);
    expect(
      dataOf(client, q.query("/users/:id", { params: { id: "1" } }).queryKey),
    ).toEqual({
      id: "1",
      name: "Ada L.",
    });
    for (const stop of stops) stop();
  });

  it("a static tag reaches every query carrying it: POST /users refetches the list and every user", async () => {
    const client = newQueryClient();
    const stops = [
      observe(client, q.query("/users")).subscribe(() => {}),
      observe(client, q.query("/users/:id", { params: { id: "1" } })).subscribe(
        () => {},
      ),
      observe(client, q.query("/cdn/:id", { params: { id: "1" } })).subscribe(
        () => {},
      ),
    ];
    await tick();
    await new MutationObserver(client, q.mutation("POST /users")).mutate({
      body: { name: "Barbara" },
    });
    expect(hits("GET /users")).toBe(2);
    expect(hits("GET /users/1")).toBe(2);
    // Control: a query without the tag.
    expect(hits("GET /cdn/1")).toBe(1);
    for (const stop of stops) stop();
  });

  it("control: a failed mutation invalidates nothing", async () => {
    const client = newQueryClient();
    const stop = observe(
      client,
      q.query("/users/:id", { params: { id: "1" } }),
    ).subscribe(() => {});
    await tick();
    const failure = await new MutationObserver(
      client,
      q.mutation("PATCH /users/:id"),
    )
      .mutate({ params: { id: "1" }, body: { name: "x", fail: true } })
      .catch((error: unknown) => error);
    expect((failure as HttpError).status).toBe(409);
    expect(hits("GET /users/1")).toBe(1);
    stop();
  });

  it("control: without the manifest a mutation invalidates nothing", async () => {
    const client = newQueryClient();
    const bare = queries(api);
    const stop = observe(
      client,
      q.query("/users/:id", { params: { id: "1" } }),
    ).subscribe(() => {});
    await tick();
    await new MutationObserver(
      client,
      bare.mutation("PATCH /users/:id"),
    ).mutate({
      params: { id: "1" },
      body: { name: "Ada L." },
    });
    expect(hits("GET /users/1")).toBe(1);
    stop();
  });
});

describe("optimistic updates (§6.4)", () => {
  /** A held PATCH, released by the returned function. */
  function holdPatch(): () => void {
    let release!: () => void;
    state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  it("writes the named route's matching queries before the request, and puts them back when it fails", async () => {
    const client = newQueryClient();
    const one = q.query("/users/:id", { params: { id: "1" } });
    const two = q.query("/users/:id", { params: { id: "2" } });
    const original = await client.fetchQuery(one);
    const other = await client.fetchQuery(two);
    const release = holdPatch();
    const rename = new MutationObserver(
      client,
      q.mutation("PATCH /users/:id", {
        optimistic: {
          "GET /users/:id": (old, variables) => ({
            ...old,
            name: variables.body.name,
          }),
        },
      }),
    );
    const done = rename
      .mutate({ params: { id: "1" }, body: { name: "Ada L.", fail: true } })
      .catch((error: unknown) => error);
    await tick();
    // In flight: the write is visible, on user 1 only.
    expect(dataOf(client, one.queryKey)).toEqual({ id: "1", name: "Ada L." });
    expect(dataOf(client, two.queryKey)).toBe(other);
    release();
    expect(((await done) as HttpError).status).toBe(409);
    // Rolled back to the very object it held.
    expect(dataOf(client, one.queryKey)).toBe(original);
    expect(dataOf(client, two.queryKey)).toBe(other);
    // With the ETag of that data: the next fetch is conditional again.
    state.conditions = [];
    await client.fetchQuery({ ...one, staleTime: 0 });
    expect(state.conditions).toEqual([expect.stringMatching(/^"/)]);
    expect(dataOf(client, one.queryKey)).toBe(original);
  });

  it("keeps the write on success, then refetches the written queries", async () => {
    const client = newQueryClient();
    const one = q.query("/users/:id", { params: { id: "1" } });
    await client.fetchQuery(one);
    const stop = observe(client, one).subscribe(() => {});
    const rename = new MutationObserver(
      client,
      q.mutation("PATCH /users/:id", {
        optimistic: {
          "GET /users/:id": (old, variables) => ({
            ...old,
            name: `${variables.body.name} (saving)`,
          }),
        },
      }),
    );
    const release = holdPatch();
    const done = rename.mutate({
      params: { id: "1" },
      body: { name: "Ada L." },
    });
    await tick();
    expect(dataOf(client, one.queryKey)).toEqual({
      id: "1",
      name: "Ada L. (saving)",
    });
    release();
    await done;
    expect(dataOf(client, one.queryKey)).toEqual({ id: "1", name: "Ada L." });
    stop();
  });

  it("writes a route without params everywhere, and skips a query the writer returns undefined for", async () => {
    const client = newQueryClient();
    const all = q.query("/users");
    const filtered = q.query("/users", { query: { q: "gr" } });
    await client.fetchQuery(all);
    const kept = await client.fetchQuery(filtered);
    const release = holdPatch();
    const done = new MutationObserver(
      client,
      q.mutation("PATCH /users/:id", {
        optimistic: {
          "GET /users": (old, variables) =>
            old.items.some((user) => user.id === variables.params.id)
              ? {
                  ...old,
                  items: old.items.map((user) =>
                    user.id === variables.params.id
                      ? { ...user, name: variables.body.name }
                      : user,
                  ),
                }
              : undefined,
        },
      }),
    )
      .mutate({ params: { id: "1" }, body: { name: "Ada L.", fail: true } })
      .catch(() => undefined);
    await tick();
    expect(client.getQueryData(all.queryKey)?.items[0]).toEqual({
      id: "1",
      name: "Ada L.",
    });
    expect(dataOf(client, filtered.queryKey)).toBe(kept);
    release();
    await done;
    expect(client.getQueryData(all.queryKey)?.items[0]).toEqual({
      id: "1",
      name: "Ada",
    });
  });

  it("control: without optimistic, nothing changes while the request is in flight", async () => {
    const client = newQueryClient();
    const one = q.query("/users/:id", { params: { id: "1" } });
    const original = await client.fetchQuery(one);
    const release = holdPatch();
    const done = new MutationObserver(client, q.mutation("PATCH /users/:id"))
      .mutate({ params: { id: "1" }, body: { name: "Ada L.", fail: true } })
      .catch(() => undefined);
    await tick();
    expect(dataOf(client, one.queryKey)).toBe(original);
    release();
    await done;
  });
});

describe("infinite queries (§6.4)", () => {
  const pages = () =>
    q.infinite(
      "/users",
      { query: { q: "a" } },
      { pageParam: "page", next: (last) => last.next ?? undefined },
    );

  it("keys without the page field, marked infinite", () => {
    expect(pages().queryKey as QueryKey).toEqual([
      "GET /users",
      { params: {}, query: { q: "a" } },
      "infinite",
    ]);
    expect(pages().initialPageParam).toBeUndefined();
    expect(pages().meta).toEqual({ tags: ["users"] });
  });

  it("pages through the route, the page param in its query field, until next gives none", async () => {
    state.users.set("4", { id: "4", name: "Barbara" });
    state.users.set("5", { id: "5", name: "Hannah" });
    const client = newQueryClient();
    const observed = observe(client, pages());
    const stop = observed.subscribe(() => {});
    await tick();
    expect(observed.getSnapshot().hasNextPage).toBe(true);
    let snapshot = await observed.fetchNextPage();
    expect(snapshot.hasNextPage).toBe(true);
    snapshot = await observed.fetchNextPage();
    expect(snapshot.hasNextPage).toBe(false);
    expect(snapshot.data?.pageParams).toEqual([undefined, 2, 3]);
    expect(
      snapshot.data?.pages.flatMap((page) => page.items.map((user) => user.id)),
    ).toEqual(["1", "2", "3", "4", "5"]);
    stop();
  });

  it("starts at initialPageParam, or the call's own value of the field", async () => {
    const client = newQueryClient();
    const fromCall = q.infinite(
      "/users",
      { query: { page: 2 } },
      { pageParam: "page", next: (last) => last.next ?? undefined },
    );
    expect(fromCall.initialPageParam).toBe(2);
    const data = await client.fetchInfiniteQuery(fromCall);
    expect(data.pages[0].items.map((user) => user.id)).toEqual(["3"]);
    expect(
      q.infinite(
        "/users",
        {},
        { pageParam: "page", initialPageParam: 1, next: () => undefined },
      ).initialPageParam,
    ).toBe(1);
  });

  it("control: a next that gives none leaves no next page", async () => {
    const client = newQueryClient();
    const observed = observe(
      client,
      q.infinite("/users", {}, { pageParam: "page", next: () => null }),
    );
    const stop = observed.subscribe(() => {});
    await tick();
    expect(observed.getSnapshot().hasNextPage).toBe(false);
    stop();
  });

  it("is not written by an optimistic update of its route", async () => {
    const client = newQueryClient();
    const infinite = pages();
    const data = await client.fetchInfiniteQuery(infinite);
    let calls = 0;
    await new MutationObserver(
      client,
      q.mutation("PATCH /users/:id", {
        optimistic: {
          "GET /users": (old) => {
            calls++;
            return old;
          },
        },
      }),
    ).mutate({ params: { id: "1" }, body: { name: "Ada L." } });
    expect(calls).toBe(0);
    expect(client.getQueryData(infinite.queryKey)?.pages[0]).toBe(
      data.pages[0],
    );
  });
});

describe("observe() (§6.3)", () => {
  it("reports pending, then success, and keeps the snapshot's identity until it changes", async () => {
    const client = newQueryClient();
    const observed = observe(
      client,
      q.query("/users/:id", { params: { id: "1" } }),
    );
    const before = observed.getSnapshot();
    expect(before.status).toBe("pending");
    expect(observed.getSnapshot()).toBe(before);
    const seen: string[] = [];
    const stop = observed.subscribe(() => {
      const snapshot = observed.getSnapshot();
      seen.push(`${snapshot.status}:${snapshot.isFetching}`);
    });
    await tick();
    const after = observed.getSnapshot();
    expect(after.status).toBe("success");
    expect(after.data).toEqual({ id: "1", name: "Ada" });
    expect(observed.getSnapshot()).toBe(after);
    expect(seen).toEqual(["pending:true", "success:false"]);
    expect(Object.keys(after).sort()).toEqual([
      "data",
      "dataUpdatedAt",
      "error",
      "isFetching",
      "isStale",
      "status",
    ]);
    stop();
  });

  it("stops notifying after unsubscribe, and the query goes inactive once the last subscriber leaves", async () => {
    const client = newQueryClient();
    const options = q.query("/users/:id", { params: { id: "1" } });
    const observed = observe(client, options);
    let first = 0;
    let second = 0;
    const stopFirst = observed.subscribe(() => first++);
    const stopSecond = observed.subscribe(() => second++);
    await tick();
    const query = client.getQueryCache().find({ queryKey: options.queryKey })!;
    expect(query.getObserversCount()).toBe(1);

    // Control: while subscribed, an invalidation refetches and notifies.
    const beforeFirst = first;
    await client.invalidateQueries({ queryKey: options.queryKey });
    await tick();
    expect(first).toBeGreaterThan(beforeFirst);

    stopFirst();
    stopFirst(); // twice is harmless
    const settledFirst = first;
    const beforeSecond = second;
    await client.invalidateQueries({ queryKey: options.queryKey });
    await tick();
    expect(first).toBe(settledFirst);
    expect(second).toBeGreaterThan(beforeSecond);
    expect(query.getObserversCount()).toBe(1);

    stopSecond();
    expect(query.getObserversCount()).toBe(0);
    const settledSecond = second;
    const fetched = hits("GET /users/1");
    await client.invalidateQueries({ queryKey: options.queryKey });
    await tick();
    expect(second).toBe(settledSecond);
    // Inactive: an invalidation no longer refetches it.
    expect(hits("GET /users/1")).toBe(fetched);
  });

  it("reports an error with the client's error class", async () => {
    const client = newQueryClient();
    const observed = observe(
      client,
      q.query("/users/:id", { params: { id: "9" } }),
    );
    const stop = observed.subscribe(() => {});
    await tick();
    const snapshot = observed.getSnapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toBeInstanceOf(HttpError);
    stop();
  });

  it("refetch() and setOptions() move the snapshot", async () => {
    const client = newQueryClient();
    const observed = observe(
      client,
      q.query("/users/:id", { params: { id: "1" } }),
    );
    const stop = observed.subscribe(() => {});
    await tick();
    state.users.set("1", { id: "1", name: "Ada L." });
    expect((await observed.refetch()).data).toEqual({
      id: "1",
      name: "Ada L.",
    });
    observed.setOptions(q.query("/users/:id", { params: { id: "2" } }));
    await tick();
    expect(observed.getSnapshot().data).toEqual({ id: "2", name: "Alan" });
    stop();
  });

  it("has no paging methods for a plain query", () => {
    const observed = observe(
      newQueryClient(),
      q.query("/users/:id", { params: { id: "1" } }),
    );
    expect("fetchNextPage" in observed).toBe(false);
  });
});
