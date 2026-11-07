/**
 * Live invalidation — one client changes data, another client's *observed*
 * queries refetch on their own. Server: bun-common's `liveInvalidation()`;
 * client: `live()` from `@kingsleyweb/bun-client/query`. Each step is asserted.
 *
 * ```bash
 * bun 14-typed-client/live-invalidation.ts
 * ```
 *
 * - **No extra server code per route.** The registry already says
 *   `renameUser` invalidates `user:{id}` and `users`; `liveInvalidation()`
 *   (mounted first, so its middleware sees the request) publishes those tags,
 *   with `{id}` filled from the request's params, once the response is a 2xx.
 * - **The client subscribes to the tags of the queries it observes** (the
 *   manifest's declared tags, refcounted) over a WebSocket channel at
 *   `/__live`, and invalidates the queries holding a published tag.
 * - **Only observed queries refetch**: query-core's rule. A query nobody
 *   watches is marked stale and fetched when it is next used.
 * - `transport: "sse"` is the same over the SSE fallback (`/__live/sse`),
 *   which `live()` also falls back to when a proxy refuses the upgrade.
 */
import { createClient } from "@kingsleyweb/bun-client";
import { live, observe, queries } from "@kingsleyweb/bun-client/query";
import { publishTags } from "@kingsleyweb/bun-common/live";
import { QueryClient } from "@tanstack/query-core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { manifest } from "./helpers/api.gen";
import type { Routes } from "./helpers/api.gen";
import { serveApi } from "./helpers/serve";

title("Live invalidation: a server publish refetches another client's queries");

/** The live topic bun-common publishes `tag` on (the name Bun's `subscriberCount` takes). */
const topic = (tag: string): string => `bun-common/live:${tag}`;

for (const transport of ["websocket", "sse"] as const) {
  step(`transport: ${transport}`);
  // A server of its own per transport, so the counts below start at zero.
  const served = await serveApi({ live: true });
  const hits = (key: string): number =>
    served.state.hits.filter((hit) => hit === key).length;

  try {
    // Client A: a query layer, with the user and the list observed.
    const api = createClient<Routes>({ baseUrl: served.baseUrl, manifest });
    const q = queries(api, { manifest });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    const user = q.query("/users/:id", { params: { id: "1" } });
    const unobserve = [
      observe(queryClient, user).subscribe(() => undefined),
      observe(queryClient, q.query("/users/", {})).subscribe(() => undefined),
    ];
    await waitFor(
      "A's first fetches",
      () => hits("GET /users/1") === 1 && hits("GET /users/") === 1,
    );
    const stop = live(api, queryClient, { transport });
    if (transport === "websocket") {
      // Each tag is a Bun pub/sub topic: the server's own count of who
      // listens, so the change below cannot beat the subscription.
      await waitFor(
        "the server holds A's tags",
        () =>
          served.server.subscriberCount(topic("user:1")) === 1 &&
          served.server.subscriberCount(topic("users")) === 1,
      );
      show("subscribers", {
        "user:1": served.server.subscriberCount(topic("user:1")),
        users: served.server.subscriberCount(topic("users")),
        "user:2": served.server.subscriberCount(topic("user:2")),
      });
    } else {
      // The SSE fallback holds no Bun topic, so there is nothing to count:
      // publish a tag by hand until A has heard it (this is also the
      // `publishTags()` source, from anywhere in the process).
      await waitFor("A to hear a hand-published tag", () => {
        publishTags(["user:1"]);
        return hits("GET /users/1") > 1;
      });
      await Bun.sleep(100);
    }
    const base = { user: hits("GET /users/1"), list: hits("GET /users/") };

    // Client B shares nothing with A but the server.
    const b = createClient<Routes>({ baseUrl: served.baseUrl, manifest });
    const name = `Ada (${transport})`;
    const renamed = await b.op.renameUser({
      params: { id: "1" },
      body: { name },
    });
    check("B's rename succeeded", renamed.ok, renamed);

    await waitFor(
      "A's user query refetched",
      () => hits("GET /users/1") > base.user,
    );
    await waitFor(
      "A's list query refetched",
      () => hits("GET /users/") > base.list,
    );
    // A request is counted when the handler starts: wait for the data itself.
    await waitFor(
      "A's cache to hold B's change",
      () => queryClient.getQueryData(user.queryKey)?.name === name,
    );
    checkEqual(
      "A holds B's change without being asked",
      queryClient.getQueryData(user.queryKey)?.name,
      name,
    );

    // After stop(), the next change is not heard.
    stop();
    if (transport === "websocket") {
      await waitFor(
        "the server dropped A's tags",
        () => served.server.subscriberCount(topic("users")) === 0,
      );
    } else {
      await Bun.sleep(100);
    }
    const settled = [hits("GET /users/1"), hits("GET /users/")];
    await b.op.renameUser({
      params: { id: "1" },
      body: { name: "Ada, unheard" },
    });
    await Bun.sleep(100);
    checkEqual(
      "after stop() nothing refetches",
      [hits("GET /users/1"), hits("GET /users/")],
      settled,
    );

    for (const off of unobserve) off();
    queryClient.clear();
  } finally {
    await served.close();
  }
}

summary();
