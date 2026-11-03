/**
 * The IndexedDB persister (`./persist`, plan §6.4, §12.1's PR-C8 row: "the
 * buster is the document hash"), with query-core's own `persistQueryClient`
 * over an in-test IndexedDB (`fakeIdb.ts`; Chrome's real one is
 * `persist.e2e.test.ts`).
 *
 * - **The buster is the documents' hash**: the generated module's
 *   `typesHash` is bun-common's `typesHash` of the documents it came from; a
 *   cache persisted under it restores, and one generated after a schema
 *   change drops it.
 * - A persisted cache **restores** into a new `QueryClient` (data, the
 *   route's tags), with no request; `maxAge` expires it.
 * - Writes are throttled, ordered with removals, and never reject; without
 *   IndexedDB nothing happens; a missing store is created beside another
 *   persister's; another tab's upgrade closes the connection.
 *
 * Each behaviour has a negative control beside it: the same setup without
 * the cause, which must not show the effect.
 */
import type { QueryKey } from "@tanstack/query-core";
import type { PersistedClient } from "@tanstack/query-persist-client-core";
import type { Routes } from "../codegen/fixtures/app.gen";
import { typesHash as serverTypesHash } from "@kingsleyweb/bun-common/lib/docs";
import { BunRouter } from "@kingsleyweb/bun-common";
import { dehydrate, QueryClient, QueryObserver } from "@tanstack/query-core";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { generateRoutes, loadDocuments } from "../../lib/codegen/index";
import { createClient } from "../../lib/index";
import { idbPersister } from "../../lib/persist";
import { invalidateTags, queries } from "../../lib/query";
import { buildRouter } from "../codegen/fixtures/app";
import { manifest, typesHash } from "../codegen/fixtures/app.gen";
import { FakeIndexedDb } from "./fakeIdb";

const APP = join(import.meta.dir, "..", "codegen", "fixtures", "app.ts");

/** Requests the fixture app saw, by `"METHOD /path"`. */
const hits = new Map<string, number>();
const app = buildRouter();
const api = createClient<Routes>({
  baseUrl: "http://app.test",
  fetch: (request) => {
    const key = `${request.method} ${new URL(request.url).pathname}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    return app.fetch(request);
  },
  manifest,
  retry: false,
  headers: { "x-tenant": "acme" },
});
const q = queries(api, { manifest });
const user = q.query("/api/users/:id", { params: { id: "42" } });

/** A client that retries nothing and keeps data for good, as a persisted cache wants (gcTime ≥ maxAge). */
const newQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });

/** What `persistQueryClient` returned, stopped after each test. */
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  hits.clear();
});

/**
 * A query's cached data, as `unknown`: `getQueryData` infers its result from
 * the context it is called in, and `expect()`'s would make it `undefined`.
 */
const dataOf = (client: QueryClient, key: QueryKey): unknown =>
  client.getQueryData(key);

/** Starts `persistQueryClient`, stopped after the test; resolves once the restore is done. */
async function persist(
  queryClient: QueryClient,
  persister: ReturnType<typeof idbPersister>,
  buster: string,
  maxAge?: number,
): Promise<void> {
  const [stop, restored] = persistQueryClient({
    queryClient,
    persister,
    buster,
    ...(maxAge === undefined ? {} : { maxAge }),
  });
  stops.push(stop);
  await restored;
}

/** Resolves once `fake` committed `count` writes in all; fails after 2 s. */
async function writes(fake: FakeIndexedDb, count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (fake.puts.length < count) {
    if (Date.now() > deadline)
      throw new Error(`${fake.puts.length} writes, expected ${count}`);
    await Bun.sleep(2);
  }
}

/** One timer turn: a `throttleTime: 0` write's timer, set before, has fired. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Lets every queued IndexedDB event run. */
const settle = () => Bun.sleep(10);

/** A persisted client of the given age, ms, holding nothing. */
const persisted = (buster: string, age = 0): PersistedClient => ({
  buster,
  timestamp: Date.now() - age,
  clientState: { mutations: [], queries: [] },
});

/** The `typesHash` a generated module exports. */
function exportedHash(code: string): string {
  const match = /^export const typesHash = "([0-9a-f]+)";$/m.exec(code);
  if (!match) throw new Error("the module exports no typesHash");
  return match[1];
}

describe("the buster is the documents' hash (§12.1, PR-C8)", () => {
  it("the generated module's typesHash is bun-common's typesHash of the documents it came from", async () => {
    const { openapi, asyncapi } = await loadDocuments({ module: APP });
    expect(typesHash).toBe(serverTypesHash({ openapi, asyncapi } as never));
    // The module's own header records the same.
    const golden = await Bun.file(
      join(import.meta.dir, "..", "codegen", "fixtures", "app.gen.ts"),
    ).text();
    expect(golden).toContain(` * typesHash: ${typesHash}\n`);
  });

  it("a cache persisted under the hash restores while the documents are unchanged", async () => {
    const fake = new FakeIndexedDb();
    const first = newQueryClient();
    await persist(
      first,
      idbPersister({ indexedDB: fake.factory, throttleTime: 0 }),
      typesHash,
    );
    await first.fetchQuery(user);
    await writes(fake, 1);

    // Regenerated from the same documents: the same hash.
    const { openapi, asyncapi } = await loadDocuments({ module: APP });
    const regenerated = exportedHash(
      generateRoutes(openapi, { asyncapi }).code,
    );
    expect(regenerated).toBe(typesHash);

    const second = newQueryClient();
    await persist(
      second,
      idbPersister({ indexedDB: fake.factory }),
      regenerated,
    );
    expect(second.getQueryData(user.queryKey)).toMatchObject({
      id: "42",
      name: "Ada",
    });
  });

  it("a schema change gives the regenerated module another hash, and the persisted cache is dropped", async () => {
    const fake = new FakeIndexedDb();
    const first = newQueryClient();
    await persist(
      first,
      idbPersister({ indexedDB: fake.factory, throttleTime: 0 }),
      typesHash,
    );
    await first.fetchQuery(user);
    await writes(fake, 1);
    expect(fake.peek("bun-client", "queries", "client")).toBeDefined();

    // The server's User gains a field: its documents change, and so does
    // the module generated from them.
    const { openapi, asyncapi } = await loadDocuments({ module: APP });
    const changed = structuredClone(openapi) as {
      components: {
        schemas: Record<string, { properties: Record<string, unknown> }>;
      };
    };
    changed.components.schemas.User.properties.nickname = { type: "string" };
    const regenerated = exportedHash(
      generateRoutes(changed, { asyncapi }).code,
    );
    expect(regenerated).not.toBe(typesHash);
    expect(regenerated).toBe(
      serverTypesHash({ openapi: changed, asyncapi } as never),
    );

    const second = newQueryClient();
    await persist(
      second,
      idbPersister({ indexedDB: fake.factory }),
      regenerated,
    );
    expect(second.getQueryData(user.queryKey)).toBeUndefined();
    // Dropped from IndexedDB too, not only left unread.
    await settle();
    expect(fake.peek("bun-client", "queries", "client")).toBeUndefined();
    expect(fake.deletes).toEqual([{ store: "queries", key: "client" }]);
  });
});

describe("restoring", () => {
  it("restores the data and the route's tags into a new QueryClient, with no request", async () => {
    const fake = new FakeIndexedDb();
    const first = newQueryClient();
    await persist(
      first,
      idbPersister({ indexedDB: fake.factory, throttleTime: 0 }),
      typesHash,
    );
    await first.fetchQuery(user);
    expect(hits.get("GET /api/users/42")).toBe(1);
    await writes(fake, 1);

    const second = newQueryClient();
    await persist(second, idbPersister({ indexedDB: fake.factory }), typesHash);
    const restored = second.getQueryData(user.queryKey);
    expect(restored).toEqual(first.getQueryData(user.queryKey));
    // A structured clone: equal, never the same object.
    expect(restored).not.toBe(first.getQueryData(user.queryKey));

    // An observer that accepts the restored data asks nothing.
    const observer = new QueryObserver(second, {
      ...user,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    await settle();
    unsubscribe();
    expect(hits.get("GET /api/users/42")).toBe(1);
    expect(observer.getCurrentResult().data).toMatchObject({ id: "42" });

    // The route's tags came back with it.
    const query = second.getQueryCache().find({ queryKey: user.queryKey })!;
    expect(query.meta?.tags).toEqual(["user:42"]);
    await invalidateTags(second, ["user:42"], { refetchType: "none" });
    expect(query.state.isInvalidated).toBe(true);
  });

  it("negative control: another key, or a fresh IndexedDB, restores nothing", async () => {
    const fake = new FakeIndexedDb();
    const first = newQueryClient();
    await persist(
      first,
      idbPersister({ indexedDB: fake.factory, throttleTime: 0 }),
      typesHash,
    );
    await first.fetchQuery(user);
    await writes(fake, 1);

    const other = newQueryClient();
    await persist(
      other,
      idbPersister({ indexedDB: fake.factory, key: "other" }),
      typesHash,
    );
    expect(other.getQueryData(user.queryKey)).toBeUndefined();

    const fresh = newQueryClient();
    await persist(
      fresh,
      idbPersister({ indexedDB: new FakeIndexedDb().factory }),
      typesHash,
    );
    expect(fresh.getQueryData(user.queryKey)).toBeUndefined();
  });

  it("maxAge expires a persisted cache, and removes it; a younger one restores", async () => {
    const hour = 60 * 60_000;
    const fake = new FakeIndexedDb();
    const writer = idbPersister({ indexedDB: fake.factory, throttleTime: 0 });
    writer.persistClient({
      ...persisted(typesHash, 2 * hour),
      clientState: (() => {
        const source = newQueryClient();
        source.setQueryData(user.queryKey, { id: "42" } as never);
        return dehydrate(source);
      })(),
    });
    await writes(fake, 1);

    // The control first: a maxAge above its age restores it.
    const young = newQueryClient();
    await persist(
      young,
      idbPersister({ indexedDB: fake.factory }),
      typesHash,
      3 * hour,
    );
    expect(dataOf(young, user.queryKey)).toEqual({ id: "42" });

    const old = newQueryClient();
    await persist(
      old,
      idbPersister({ indexedDB: fake.factory }),
      typesHash,
      hour,
    );
    expect(old.getQueryData(user.queryKey)).toBeUndefined();
    await settle();
    expect(fake.peek("bun-client", "queries", "client")).toBeUndefined();
  });

  it("a restored query's first fetch is unconditional: the ETags are the live client's, not persisted", async () => {
    const conditions: (string | null)[] = [];
    const router = new BunRouter();
    router.get("/items/:id", (req, res) => {
      conditions.push(req.get("if-none-match") ?? null);
      res.setEtag(true);
      res.json({ id: req.params.id });
    });
    interface ItemRoutes {
      "GET /items/:id": {
        params: { id: string };
        responses: { 200: { id: string } };
      };
    }
    const items = queries(
      createClient<ItemRoutes>({
        baseUrl: "http://items.test",
        fetch: (request) => router.fetch(request),
        retry: false,
      }),
    );
    const item = items.query("/items/:id", { params: { id: "1" } });
    const fake = new FakeIndexedDb();
    const first = newQueryClient();
    await persist(
      first,
      idbPersister({ indexedDB: fake.factory, throttleTime: 0 }),
      "h",
    );
    await first.fetchQuery(item);
    await first.refetchQueries({ queryKey: item.queryKey });
    // The control: the live client revalidates with its ETag.
    expect(conditions[0]).toBeNull();
    expect(conditions[1]).toMatch(/^W?\/?"/);
    await settle();

    const second = newQueryClient();
    await persist(second, idbPersister({ indexedDB: fake.factory }), "h");
    expect(dataOf(second, item.queryKey)).toEqual({ id: "1" });
    // A hydrated query has no query function until a fetch brings one.
    await second.fetchQuery(item);
    expect(conditions).toHaveLength(3);
    expect(conditions[2]).toBeNull();
  });
});

describe("writing", () => {
  it("writes once per throttleTime, the latest cache winning", async () => {
    const fake = new FakeIndexedDb();
    const persister = idbPersister({
      indexedDB: fake.factory,
      throttleTime: 30,
    });
    for (let index = 0; index < 50; index++)
      persister.persistClient(persisted(`b${index}`));
    await writes(fake, 1);
    await Bun.sleep(60);
    expect(fake.puts).toHaveLength(1);
    expect((fake.puts[0].value as PersistedClient).buster).toBe("b49");

    // The control: a call after the window writes again.
    persister.persistClient(persisted("later"));
    await writes(fake, 2);
    expect((fake.puts[1].value as PersistedClient).buster).toBe("later");
  });

  it("persistQueryClient's save on every cache event becomes one write", async () => {
    const fake = new FakeIndexedDb();
    const client = newQueryClient();
    await persist(
      client,
      idbPersister({ indexedDB: fake.factory, throttleTime: 20 }),
      "h",
    );
    for (let index = 0; index < 20; index++)
      client.setQueryData(["n", index], index);
    await writes(fake, 1);
    await Bun.sleep(40);
    expect(fake.puts).toHaveLength(1);
    expect(
      (fake.puts[0].value as PersistedClient).clientState.queries,
    ).toHaveLength(20);
  });

  it("removeClient cancels a write still waiting, and runs after one already started", async () => {
    const fake = new FakeIndexedDb();
    const persister = idbPersister({
      indexedDB: fake.factory,
      throttleTime: 20,
    });
    persister.persistClient(persisted("waiting"));
    await persister.removeClient();
    await Bun.sleep(40);
    expect(fake.puts).toHaveLength(0);

    const now = idbPersister({ indexedDB: fake.factory, throttleTime: 0 });
    now.persistClient(persisted("started"));
    // Let the write begin (its timer fires), then remove at once.
    await tick();
    await now.removeClient();
    expect(fake.puts).toHaveLength(1);
    expect(fake.peek("bun-client", "queries", "client")).toBeUndefined();
    expect(await now.restoreClient()).toBeUndefined();
  });

  it("restoreClient reads after the writes before it", async () => {
    const fake = new FakeIndexedDb();
    const persister = idbPersister({
      indexedDB: fake.factory,
      throttleTime: 0,
    });
    persister.persistClient(persisted("one"));
    await tick();
    expect((await persister.restoreClient())?.buster).toBe("one");
  });
});

describe("failures never reject", () => {
  it("a value IndexedDB cannot clone goes to onError, and the next write still lands", async () => {
    const fake = new FakeIndexedDb();
    const errors: unknown[] = [];
    const persister = idbPersister({
      indexedDB: fake.factory,
      throttleTime: 0,
      onError: (error) => errors.push(error),
    });
    persister.persistClient({
      ...persisted("bad"),
      clientState: { mutations: [], queries: [{ fn: () => {} }] } as never,
    });
    await Bun.sleep(10);
    expect(errors).toHaveLength(1);
    expect((errors[0] as DOMException).name).toBe("DataCloneError");
    expect(fake.puts).toHaveLength(0);

    persister.persistClient(persisted("good"));
    await writes(fake, 1);
    expect(errors).toHaveLength(1);
  });

  it("a failed open resolves the restore as no cache, through onError, and the next use opens again", async () => {
    const fake = new FakeIndexedDb();
    const errors: unknown[] = [];
    const persister = idbPersister({
      indexedDB: fake.factory,
      throttleTime: 0,
      onError: (error) => errors.push(error),
    });
    fake.failNext(
      "open",
      new DOMException("blocked by policy", "UnknownError"),
    );
    expect(await persister.restoreClient()).toBeUndefined();
    expect(errors).toHaveLength(1);
    persister.persistClient(persisted("after"));
    await writes(fake, 1);
    expect(fake.opens).toBe(2);
  });

  it("a failed write (quota, say) goes to onError; persistQueryClient sees no rejection", async () => {
    const fake = new FakeIndexedDb();
    const errors: unknown[] = [];
    const client = newQueryClient();
    await persist(
      client,
      idbPersister({
        indexedDB: fake.factory,
        throttleTime: 0,
        onError: (error) => errors.push(error),
      }),
      "h",
    );
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      fake.failNext("put", new DOMException("full", "QuotaExceededError"));
      client.setQueryData(["k"], 1);
      await Bun.sleep(20);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
    expect((errors[0] as DOMException).name).toBe("QuotaExceededError");
  });

  it("negative control: without onError a failure is swallowed, never thrown", async () => {
    const fake = new FakeIndexedDb();
    const persister = idbPersister({ indexedDB: fake.factory });
    fake.failNext("get", new DOMException("x", "UnknownError"));
    expect(await persister.restoreClient()).toBeUndefined();
  });
});

describe("the database", () => {
  it("without IndexedDB every method does nothing, and reports nothing", async () => {
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined();
    const errors: unknown[] = [];
    const persister = idbPersister({
      throttleTime: 0,
      onError: (error) => errors.push(error),
    });
    persister.persistClient(persisted("x"));
    await Bun.sleep(5);
    expect(await persister.restoreClient()).toBeUndefined();
    await persister.removeClient();
    expect(errors).toEqual([]);
  });

  it("uses globalThis.indexedDB when no factory is given, read on first use", async () => {
    const fake = new FakeIndexedDb();
    const persister = idbPersister({ throttleTime: 0 });
    (globalThis as { indexedDB?: unknown }).indexedDB = fake;
    try {
      persister.persistClient(persisted("global"));
      await writes(fake, 1);
    } finally {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  });

  it("names its database, store and key; a second store in the same database is created beside the first", async () => {
    const fake = new FakeIndexedDb();
    const a = idbPersister({
      indexedDB: fake.factory,
      database: "app",
      store: "a",
      key: "k",
      throttleTime: 0,
    });
    a.persistClient(persisted("a"));
    await writes(fake, 1);
    const b = idbPersister({
      indexedDB: fake.factory,
      database: "app",
      store: "b",
      key: "k",
      throttleTime: 0,
    });
    b.persistClient(persisted("b"));
    await writes(fake, 2);
    expect(fake.databases.get("app")!.version).toBe(2);
    expect((fake.peek("app", "a", "k") as PersistedClient).buster).toBe("a");
    expect((fake.peek("app", "b", "k") as PersistedClient).buster).toBe("b");
    // The first persister's connection was told of the upgrade and reopens.
    expect((await a.restoreClient())?.buster).toBe("a");
  });

  it("closes its connection when another tab upgrades the database, and opens again on the next use", async () => {
    const fake = new FakeIndexedDb();
    const persister = idbPersister({
      indexedDB: fake.factory,
      throttleTime: 0,
    });
    persister.persistClient(persisted("one"));
    await writes(fake, 1);
    expect(fake.connections.size).toBe(1);
    fake.versionChange("bun-client");
    expect(fake.connections.size).toBe(0);
    persister.persistClient(persisted("two"));
    await writes(fake, 2);
    expect(fake.opens).toBe(2);
  });
});
