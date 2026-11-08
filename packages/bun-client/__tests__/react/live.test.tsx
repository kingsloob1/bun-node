/**
 * `useLive` (`./react`, plan §7.1; `websocket.md` §9) in a DOM (happy-dom,
 * registered per file by `./dom.ts`), against bun-common's
 * `liveInvalidation()` on a router run through `router.fetch()`: its SSE
 * fallback (the live channel needs a socket, and happy-dom's `WebSocket`
 * is not Bun's). An invalidation refetches a rendered query, and nothing
 * once the component unmounted; StrictMode's double mount opens one
 * stream; refused tags reach the latest `onDenied` without a new stream.
 * Each behaviour has a negative control beside it.
 */
import type { RouteManifest } from "../../lib/index";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { ReactNode } from "react";
import { BunRouter, createTestLogger } from "@kingsleyweb/bun-common";
import { liveInvalidation, publishTags } from "@kingsleyweb/bun-common/live";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "bun:test";
import { StrictMode } from "react";
import { createClient } from "../../lib/index";
import { queries } from "../../lib/query";
import { createApiHooks } from "../../lib/react";
import { render, settle, setupDom, waitFor } from "./dom";

setupDom();

interface Routes {
  "GET /users/:id": {
    params: { id: string };
    responses: { 200: { id: string; name: string } };
  };
}

const manifest = {
  "GET /users/:id": { statuses: [200], cache: { tags: ["user:{id}"] } },
} as const satisfies RouteManifest<Routes>;

/** Requests sent, by `"METHOD /path"`. */
const sent = new Map<string, number>();
const hits = (key: string): number => sent.get(key) ?? 0;

/** A client of `router`, counting its requests, and its hooks. */
function hooksOf(router: BunRouter) {
  const api = createClient<Routes>({
    baseUrl: "http://localhost",
    fetch: (request) => {
      const key = `${request.method} ${new URL(request.url).pathname}`;
      sent.set(key, (sent.get(key) ?? 0) + 1);
      return router.fetch(request);
    },
    retry: false,
    manifest,
  });
  return createApiHooks(queries(api, { manifest }));
}

/** The app: bun-common's live fallback first, then the users. */
const app = new BunRouter();
app.setLogger(createTestLogger().logger);
app.use(liveInvalidation(app, { authorize: (_req, _res, next) => next() }));
app.get("/users/:id", (req: BunRequest, res: BunResponse) => {
  res.json({ id: req.params.id, name: "Ada" });
});
const { useApi, useLive } = hooksOf(app);

const newQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });

/** `node` under a `QueryClientProvider` for `client`. */
function within(client: QueryClient, node: ReactNode): ReactNode {
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

/** One user's name, through `useApi`. */
function UserName({ id }: { id: string }) {
  const user = useApi("/users/:id", { params: { id } });
  return <p>{user.data?.name ?? "loading"}</p>;
}

/** The app's root: live invalidation on, and one user. */
function Root({ id }: { id: string }) {
  useLive({ transport: "sse" });
  return <UserName id={id} />;
}

beforeEach(() => {
  sent.clear();
});

describe("useLive (§7.1, websocket.md §9)", () => {
  it("refetches a rendered query when its tag is invalidated (control: another tag refetches nothing)", async () => {
    const client = newQueryClient();
    const view = await render(within(client, <Root id="1" />));
    await waitFor(() => expect(view.text()).toBe("Ada"));
    await waitFor(() => expect(hits("GET /__live/sse")).toBe(1));
    await settle();
    publishTags(["user:2"]);
    await settle();
    expect(hits("GET /users/1")).toBe(1);
    publishTags(["user:1"]);
    await waitFor(() => expect(hits("GET /users/1")).toBe(2));
  });

  it("stops on unmount: the same invalidation refetches nothing once it has gone", async () => {
    const client = newQueryClient();
    const view = await render(within(client, <Root id="1" />));
    await waitFor(() => expect(hits("GET /__live/sse")).toBe(1));
    await settle();
    // The query stays observed without the live root, so a refetch would show.
    const rest = await render(within(client, <UserName id="1" />));
    await view.unmount();
    await settle();
    publishTags(["user:1"]);
    await settle();
    await settle();
    expect(hits("GET /users/1")).toBe(1);
    // Control: mounted again, the invalidation does refetch.
    await render(within(client, <Root id="1" />));
    await waitFor(() => expect(hits("GET /__live/sse")).toBe(2));
    await settle();
    publishTags(["user:1"]);
    await waitFor(() => expect(hits("GET /users/1")).toBe(2));
    await rest.unmount();
  });

  it("opens one stream under StrictMode's double mount (control: two roots open two)", async () => {
    const client = newQueryClient();
    await render(
      within(
        client,
        <StrictMode>
          <Root id="1" />
        </StrictMode>,
      ),
    );
    await waitFor(() => expect(hits("GET /__live/sse")).toBe(1));
    await settle();
    await settle();
    expect(hits("GET /__live/sse")).toBe(1);
    const other = newQueryClient();
    await render(within(other, <Root id="2" />));
    await waitFor(() => expect(hits("GET /__live/sse")).toBe(2));
  });
});

describe("useLive's onDenied (hello's `denied`)", () => {
  /** A live fallback answering each stream with a `hello` that refuses every tag asked for, held open. */
  const refusing = new BunRouter();
  refusing.get("/__live/sse", (req: BunRequest, res: BunResponse) => {
    const asked = (req.query as { tag?: string | string[] }).tag ?? [];
    const denied = Array.isArray(asked) ? asked : [asked];
    res.setHeader("content-type", "text/event-stream");
    res.status(200);
    res.write(
      `event: hello\ndata: ${JSON.stringify({ epoch: "e1", seq: 0, denied })}\n\n`,
    );
  });
  refusing.get("/users/:id", (req: BunRequest, res: BunResponse) => {
    res.json({ id: req.params.id, name: "Ada" });
  });
  const refused = hooksOf(refusing);

  /** A root reporting refusals to `onDenied`, with the users named. */
  function Refused(props: {
    ids: string[];
    onDenied: (tags: string[]) => void;
  }) {
    refused.useLive({ transport: "sse", onDenied: props.onDenied });
    return (
      <>
        {props.ids.map((id) => (
          <Reader
            key={id}
            id={id}
          />
        ))}
      </>
    );
  }
  function Reader({ id }: { id: string }) {
    const user = refused.useApi("/users/:id", { params: { id } });
    return <p>{user.data?.name ?? "loading"}</p>;
  }

  it("reports refused tags to the latest callback, and a new callback opens no new stream", async () => {
    const client = newQueryClient();
    const first: string[][] = [];
    const second: string[][] = [];
    const view = await render(
      within(
        client,
        <Refused
          ids={["1"]}
          onDenied={(tags) => first.push(tags)}
        />,
      ),
    );
    await waitFor(() => expect(first).toEqual([["user:1"]]));
    expect(hits("GET /__live/sse")).toBe(1);
    // A new function: no restart.
    await view.rerender(
      within(
        client,
        <Refused
          ids={["1"]}
          onDenied={(tags) => second.push(tags)}
        />,
      ),
    );
    await settle();
    expect(hits("GET /__live/sse")).toBe(1);
    // A new tag reopens the stream; its hello reaches the new callback.
    await view.rerender(
      within(
        client,
        <Refused
          ids={["1", "2"]}
          onDenied={(tags) => second.push(tags)}
        />,
      ),
    );
    await waitFor(() => expect(second.flat()).toContain("user:2"));
    expect(first).toEqual([["user:1"]]);
  });

  it("reports a 403 LIVE_TAGS_DENIED (every tag refused, no stream) to onDenied, and asks once", async () => {
    const refusingAll = new BunRouter();
    let asked = 0;
    refusingAll.get("/__live/sse", (req: BunRequest, res: BunResponse) => {
      asked++;
      const tags = (req.query as { tag?: string | string[] }).tag ?? [];
      res.status(403);
      res.setHeader("content-type", "application/problem+json");
      res.send(
        JSON.stringify({
          type: "urn:bun-common:error:LIVE_TAGS_DENIED",
          title: "Forbidden",
          status: 403,
          code: "LIVE_TAGS_DENIED",
          detail: "None of the requested tags may be watched.",
          denied: Array.isArray(tags) ? tags : [tags],
        }),
      );
    });
    refusingAll.get("/users/:id", (req: BunRequest, res: BunResponse) => {
      res.json({ id: req.params.id, name: "Ada" });
    });
    const hooks = hooksOf(refusingAll);
    function AllRefused(props: { onDenied: (tags: string[]) => void }) {
      hooks.useLive({ transport: "sse", onDenied: props.onDenied });
      const user = hooks.useApi("/users/:id", { params: { id: "1" } });
      return <p>{user.data?.name ?? "loading"}</p>;
    }
    const reported: string[][] = [];
    const view = await render(
      within(
        newQueryClient(),
        <AllRefused onDenied={(tags) => reported.push(tags)} />,
      ),
    );
    await waitFor(() => expect(view.text()).toBe("Ada"));
    await waitFor(() => expect(reported).toEqual([["user:1"]]));
    await settle();
    expect(asked).toBe(1);
  });
});
