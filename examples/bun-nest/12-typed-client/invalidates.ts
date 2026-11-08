/**
 * `@Invalidates` — a controller method names the cache tags it invalidates,
 * and two things follow: the Nest app publishes them to bun-common's live
 * channel when the handler succeeds (so *another* client's observed queries
 * refetch), and the generated manifest documents them (so the client's *own*
 * mutation invalidates its own queries). Each step is asserted.
 *
 * ```bash
 * bun 12-typed-client/invalidates.ts   # from examples/bun-nest
 * ```
 *
 * - **Mount `liveInvalidation()` first**, on the adapter's instance, before
 *   `app.listen()`. No Nest module is needed: it serves `/__live` and its SSE
 *   fallback itself. `@Invalidates("user:{id}", "users")` fills `{id}` from the
 *   request's params and publishes once, when the handler's observable
 *   completes without an error, before the response is written.
 * - **A handler that throws publishes nothing**, even when an exception
 *   filter would answer 200; the second half checks the not-found case.
 * - **The tags are also `x-bun-cache.invalidates`** in the document, so
 *   `q.mutation("PATCH /users/:id")` invalidates `user:1` and `users` itself.
 */
import { createClient } from "@kingsleyweb/bun-client";
import { live, observe, queries } from "@kingsleyweb/bun-client/query";
import { QueryClient, MutationObserver } from "@tanstack/query-core";
import { checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { createApp, store } from "./helpers/app";
import { manifest } from "./helpers/api.gen";
import type { Routes } from "./helpers/api.gen";
import "reflect-metadata";

title("@Invalidates: a Nest mutation refetches observed queries");

store.reset();
const { app, adapter } = await createApp({ live: true });
await app.listen(0);
const baseUrl = `http://127.0.0.1:${adapter.listeningPort}`;
const server = adapter.server;
if (server === undefined) throw new Error("the app is not listening");

/** How many times `key` reached a controller. */
const hits = (key: string): number =>
  store.hits.filter((hit) => hit === key).length;

/** The live topic bun-common publishes `tag` on (the name Bun's `subscriberCount` takes). */
const topic = (tag: string): string => `bun-common/live:${tag}`;

try {
  /* ---------------------------------------------------------------- */
  step("Another client's PATCH refetches this client's observed queries");

  // Client A: observes Ada and the list, and listens on the live channel.
  const apiA = createClient<Routes>({ baseUrl, manifest });
  const qA = queries(apiA, { manifest });
  const clientA = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const ada = qA.query("/users/:id", { params: { id: "1" } });
  const unobserve = [
    observe(clientA, ada).subscribe(() => undefined),
    observe(clientA, qA.query("/users", {})).subscribe(() => undefined),
  ];
  await waitFor(
    "A's first fetches",
    () => hits("GET /users/1") === 1 && hits("GET /users") === 1,
  );
  const stop = live(apiA, clientA);
  await waitFor(
    "the server holds A's tags",
    () =>
      server.subscriberCount(topic("user:1")) === 1 &&
      server.subscriberCount(topic("users")) === 1,
  );

  // Client B: a plain client, sharing nothing with A but the server.
  const apiB = createClient<Routes>({ baseUrl, manifest });
  const renamed = await apiB.op.renameUser({
    params: { id: "1" },
    body: { name: "Ada Lovelace" },
  });
  checkEqual("B's PATCH succeeded", renamed.ok, true);

  await waitFor("A's user query refetched", () => hits("GET /users/1") === 2);
  await waitFor("A's list refetched", () => hits("GET /users") === 2);
  // A request is counted when the controller runs, before its response
  // reaches A's cache: wait for the data itself.
  await waitFor(
    "A's cache to hold B's change",
    () => clientA.getQueryData(ada.queryKey)?.name === "Ada Lovelace",
  );
  checkEqual(
    "A holds B's change without being asked",
    clientA.getQueryData(ada.queryKey)?.name,
    "Ada Lovelace",
  );

  /* ---------------------------------------------------------------- */
  step("A handler that throws publishes nothing");

  const miss = await apiB.op.renameUser({
    params: { id: "99" },
    body: { name: "Nobody" },
  });
  checkEqual(
    "the controller threw a 404",
    [miss.ok, miss.status],
    [false, 404],
  );
  await Bun.sleep(100);
  checkEqual(
    "so A refetched nothing more",
    [hits("GET /users/1"), hits("GET /users")],
    [2, 2],
  );

  stop();
  for (const off of unobserve) off();
  clientA.clear();

  /* ---------------------------------------------------------------- */
  step(
    "The client's own mutation invalidates by the same tags (from the manifest)",
  );

  const qB = queries(apiB, { manifest });
  const clientB = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const grace = qB.query("/users/:id", { params: { id: "2" } });
  const stopObserving = observe(clientB, grace).subscribe(() => undefined);
  await waitFor(
    "B's first fetch of Grace",
    () => clientB.getQueryData(grace.queryKey) !== undefined,
  );
  show(
    "manifest says PATCH invalidates",
    manifest["PATCH /users/:id"].cache.invalidates,
  );

  await new MutationObserver(clientB, qB.mutation("PATCH /users/:id")).mutate({
    params: { id: "2" },
    body: { name: "Grace Hopper" },
  });
  checkEqual(
    "Grace (tag user:2) was refetched by B's own mutation",
    hits("GET /users/2"),
    2,
  );
  checkEqual(
    "with the new name",
    clientB.getQueryData(grace.queryKey)?.name,
    "Grace Hopper",
  );
  stopObserving();
  clientB.clear();
} finally {
  await app.close();
}

summary();
