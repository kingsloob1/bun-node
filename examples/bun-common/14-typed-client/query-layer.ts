/**
 * The query layer — `@kingsleyweb/bun-client/query` puts the generated route
 * map on TanStack's `@tanstack/query-core` (no React, no DOM): keys from the
 * route, cache tags, `ETag` revalidation, tag-driven invalidation and an
 * optimistic write that rolls back. Each behaviour is asserted.
 *
 * ```bash
 * bun 14-typed-client/query-layer.ts
 * ```
 *
 * - **A query is `{ queryKey, queryFn, meta }`** from `q.query(path, options)`,
 *   typed by the route. The key is `[routeKey, { params, query }]`.
 * - **Tags come from the server's `.describe({ cache })`**, via the manifest:
 *   `user:{id}` is filled from the call's params (`user:1`). A mutation's
 *   `cache.invalidates` is invalidated when it succeeds, and query-core
 *   refetches the queries somebody is observing.
 * - **`ETag`**: `GET /users/:id` sets one, so the next fetch sends
 *   `If-None-Match`, a 304 keeps the very same data object.
 * - **Optimistic updates** write a cached query before the request and put
 *   it back exactly if the request fails.
 *
 * Live invalidation (a *different* client's change refetching this one's
 * queries) is `live-invalidation.ts`.
 */
import { createClient } from "@kingsleyweb/bun-client";
import {
  invalidateTags,
  observe,
  queries,
  tagsOfQuery,
} from "@kingsleyweb/bun-client/query";
import { MutationObserver, QueryClient } from "@tanstack/query-core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { manifest } from "./helpers/api.gen";
import type { Routes } from "./helpers/api.gen";
import { serveApi } from "./helpers/serve";

title("The query layer: keys, tags, ETag, invalidation, optimistic updates");

const served = await serveApi();
const api = createClient<Routes>({ baseUrl: served.baseUrl, manifest });
const q = queries(api, { manifest });
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, retry: false } },
});

/** How many times `key` reached the server. */
const hits = (key: string): number =>
  served.state.hits.filter((hit) => hit === key).length;

try {
  /* ---------------------------------------------------------------- */
  step("A query: its key, its tags and its data");

  const ada = q.query("/users/:id", { params: { id: "1" } });
  check(
    "the key is [routeKey, { params, query }]",
    Bun.deepEquals(ada.queryKey, [
      "GET /users/:id",
      { params: { id: "1" }, query: {} },
    ]),
    ada.queryKey,
  );
  const first = await queryClient.fetchQuery(ada);
  // `getQueryData` is typed by the key: User, from the generated map.
  checkEqual("fetchQuery resolves the 2xx body", first.name, "Ada");
  const cached = queryClient.getQueryCache().find({ queryKey: ada.queryKey });
  checkEqual(
    "the tags were filled from the params",
    cached && tagsOfQuery(queryClient, cached),
    ["user:1", "users"],
  );

  /* ---------------------------------------------------------------- */
  step("ETag: a 304 keeps the same object");

  // staleTime 0 for this call: stale, so fetchQuery asks the server again.
  const again = await queryClient.fetchQuery({ ...ada, staleTime: 0 });
  show("If-None-Match seen by the server", served.state.conditions);
  check(
    "the second request carried the ETag",
    served.state.conditions[1] !== null,
    served.state.conditions,
  );
  check("the 304 kept the identical data object", again === first);

  /* ---------------------------------------------------------------- */
  step("A mutation invalidates by tag");

  const list = q.query("/users/", {});
  const grace = q.query("/users/:id", { params: { id: "2" } });
  // Observed queries are the ones query-core refetches on invalidation.
  const observed = [
    observe(queryClient, ada).subscribe(() => undefined),
    observe(queryClient, list).subscribe(() => undefined),
    observe(queryClient, grace).subscribe(() => undefined),
  ];
  await waitFor(
    "the list and Grace are loaded",
    () => hits("GET /users/") === 1 && hits("GET /users/2") === 1,
  );

  const rename = q.mutation("PATCH /users/:id");
  const mutation = new MutationObserver(queryClient, rename);
  await mutation.mutate({
    params: { id: "1" },
    body: { name: "Ada Lovelace" },
  });
  // `invalidates: ["user:{id}", "users"]` → user:1 and users. Every query here
  // carries `users`, so all three refetch.
  checkEqual("Ada (user:1, users) was refetched", hits("GET /users/1"), 3);
  checkEqual("the list (users) was refetched", hits("GET /users/"), 2);
  checkEqual("Grace (users) was refetched too", hits("GET /users/2"), 2);
  checkEqual(
    "and the cache holds the new name",
    queryClient.getQueryData(ada.queryKey)?.name,
    "Ada Lovelace",
  );

  step("…or by hand, one tag with invalidateTags()");
  await invalidateTags(queryClient, ["user:2"]);
  checkEqual("Grace, tagged user:2, refetched", hits("GET /users/2"), 3);
  checkEqual(
    "Ada and the list, not tagged user:2, did not",
    [hits("GET /users/1"), hits("GET /users/")],
    [3, 2],
  );

  /* ---------------------------------------------------------------- */
  step("An optimistic update, rolled back when the request fails");

  // The server forgets Grace, so the rename below is answered 404.
  served.state.users.delete("2");
  const seen: (string | undefined)[] = [
    queryClient.getQueryData(grace.queryKey)?.name,
  ];
  const unwatch = queryClient.getQueryCache().subscribe(() => {
    const name = queryClient.getQueryData(grace.queryKey)?.name;
    if (seen.at(-1) !== name) seen.push(name);
  });
  const optimistic = q.mutation("PATCH /users/:id", {
    optimistic: {
      "GET /users/:id": (old, variables) => ({
        ...old,
        name: variables.body.name,
      }),
    },
  });
  let failure: unknown;
  try {
    await new MutationObserver(queryClient, optimistic).mutate({
      params: { id: "2" },
      body: { name: "Nobody" },
    });
  } catch (error) {
    failure = error;
  }
  unwatch();
  show("names the cache held, in order", seen);
  check("the request failed (404)", failure instanceof Error, failure);
  checkEqual("written ahead of the request, then put back", seen.slice(0, 3), [
    "Grace",
    "Nobody",
    "Grace",
  ]);
  checkEqual(
    "the data is the original",
    queryClient.getQueryData(grace.queryKey)?.name,
    "Grace",
  );

  for (const stop of observed) stop();
} finally {
  queryClient.clear();
  await served.close();
}

summary();
