/**
 * The React binding (`./react`, plan §7.1, §12.1's PR-C6 row) in a DOM
 * (happy-dom, registered per file by `./dom.ts`), against a real bun-common
 * router through `router.fetch()`: pending, success and error; one fetch
 * for two components; a refetch on invalidation; a mutation's
 * `invalidates`; an optimistic write rendered and rolled back; Suspense's
 * `staleTime` floor; infinite pages; StrictMode's double mount; and the
 * unmount releasing every observer and timer. Each behaviour has a negative
 * control beside it: the same setup without the cause, which must not show
 * the effect.
 */
import type { RouteManifest } from "../../lib/index";
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { ReactNode } from "react";
import { BunRouter } from "@kingsleyweb/bun-common";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "bun:test";
import { StrictMode, Suspense, useEffect } from "react";
import { createClient, HttpError } from "../../lib/index";
import { invalidateTags, queries } from "../../lib/query";
import { createApiHooks } from "../../lib/react";
import { act, click, render, settle, setupDom, waitFor } from "./dom";

setupDom();

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
    query: Record<never, never>;
    body: undefined;
    responses: { 200: User; 404: { code: "NOT_FOUND" } };
  };
  "GET /users": {
    params: Record<never, never>;
    query: { page?: number };
    body: undefined;
    responses: { 200: Page };
  };
  "PATCH /users/:id": {
    params: { id: string };
    query: Record<never, never>;
    body: { name: string; fail?: boolean };
    responses: { 200: User; 409: { code: "CONFLICT" } };
  };
}

const manifest = {
  "GET /users/:id": { statuses: [200, 404], cache: { tags: ["user:{id}"] } },
  "GET /users": { statuses: [200], cache: { tags: ["users"] } },
  "PATCH /users/:id": {
    statuses: [200, 409],
    cache: { invalidates: ["user:{id}", "users"] },
  },
} as const satisfies RouteManifest<Routes>;

/** The server's state, reset before each test. */
const state = {
  users: new Map<string, User>(),
  /** Holds a PATCH until released, so a test can look at the screen mid-flight. */
  hold: undefined as Promise<void> | undefined,
  /** Holds a user's GET until released, so a test can tell a rollback from a refetch. */
  holdGet: undefined as Promise<void> | undefined,
};

const router = new BunRouter();
router.get("/users/:id", async (req: BunRequest, res: BunResponse) => {
  await state.holdGet;
  const user = state.users.get(req.params.id as string);
  if (!user) {
    res.status(404).json({ code: "NOT_FOUND" });
    return;
  }
  res.json(user);
});
router.get("/users", (req: BunRequest, res: BunResponse) => {
  const page = Number((req.query as { page?: string }).page ?? "1");
  const all = [...state.users.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  res.json({
    items: all.slice((page - 1) * 2, page * 2),
    next: page * 2 < all.length ? page + 1 : null,
  });
});
router.patch("/users/:id", async (req: BunRequest, res: BunResponse) => {
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

/** Requests sent, by `"METHOD /path"`, at the client's fetch. */
const sent = new Map<string, number>();
const hits = (key: string): number => sent.get(key) ?? 0;

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
const q = queries(api, { manifest });
const { useApi, useApiSuspense, useApiInfinite, useApiMutation } =
  createApiHooks(q);

/** The same hooks without the manifest: no route declares a tag. */
const bare = createApiHooks(queries(api));

/** A client that retries nothing: a failure is a failure. */
const newQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** `node` under a `QueryClientProvider` for `client`. */
function within(client: QueryClient, node: ReactNode): ReactNode {
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

/** The number of observers of `client`'s queries (every component reading one is one). */
const observers = (client: QueryClient): number =>
  client
    .getQueryCache()
    .getAll()
    .reduce((sum, query) => sum + query.getObserversCount(), 0);

beforeEach(() => {
  state.users = new Map([
    ["1", { id: "1", name: "Ada" }],
    ["2", { id: "2", name: "Alan" }],
    ["3", { id: "3", name: "Grace" }],
  ]);
  state.hold = undefined;
  state.holdGet = undefined;
  sent.clear();
});

/** One user's name, through `useApi`. */
function UserName({ id }: { id: string }) {
  const user = useApi("/users/:id", { params: { id } });
  if (user.isPending) return <p>loading</p>;
  if (user.isError) {
    const { error } = user;
    return (
      <p>
        {error instanceof HttpError
          ? `error ${error.status} ${(error.error as { code: string }).code}`
          : `error ${error.message}`}
      </p>
    );
  }
  return <p>{user.data.name}</p>;
}

describe("useApi (§7.1)", () => {
  it("renders pending, then the route's data", async () => {
    const client = newQueryClient();
    const view = await render(within(client, <UserName id="1" />));
    expect(view.text()).toBe("loading");
    await waitFor(() => expect(view.text()).toBe("Ada"));
    expect(hits("GET /users/1")).toBe(1);
  });

  it("renders the route's declared error as the client's HttpError, status and body", async () => {
    const client = newQueryClient();
    const view = await render(within(client, <UserName id="9" />));
    await waitFor(() => expect(view.text()).toBe("error 404 NOT_FOUND"));
  });

  it("fetches once for two components reading the same route and params", async () => {
    const client = newQueryClient();
    const view = await render(
      within(
        client,
        <>
          <UserName id="1" />
          <UserName id="1" />
        </>,
      ),
    );
    await waitFor(() => expect(view.text()).toBe("AdaAda"));
    expect(hits("GET /users/1")).toBe(1);
    expect(observers(client)).toBe(2);
  });

  it("control: two different params are two queries, two fetches", async () => {
    const client = newQueryClient();
    const view = await render(
      within(
        client,
        <>
          <UserName id="1" />
          <UserName id="2" />
        </>,
      ),
    );
    await waitFor(() => expect(view.text()).toBe("AdaAlan"));
    expect(hits("GET /users/1") + hits("GET /users/2")).toBe(2);
  });

  it("refetches and re-renders when a tag it carries is invalidated", async () => {
    const client = newQueryClient();
    const view = await render(within(client, <UserName id="1" />));
    await waitFor(() => expect(view.text()).toBe("Ada"));
    state.users.set("1", { id: "1", name: "Ada Lovelace" });
    await act(() => invalidateTags(client, ["user:1"]));
    await waitFor(() => expect(view.text()).toBe("Ada Lovelace"));
    expect(hits("GET /users/1")).toBe(2);
  });

  it("control: invalidating another user's tag neither refetches nor re-renders it", async () => {
    const client = newQueryClient();
    const view = await render(within(client, <UserName id="1" />));
    await waitFor(() => expect(view.text()).toBe("Ada"));
    state.users.set("1", { id: "1", name: "Ada Lovelace" });
    await act(() => invalidateTags(client, ["user:2"]));
    await settle();
    expect(view.text()).toBe("Ada");
    expect(hits("GET /users/1")).toBe(1);
  });

  it("passes react-query's options through: enabled, select, and a meta merged under the route's tags", async () => {
    const client = newQueryClient();
    let enabled = false;
    function Names() {
      const names = useApi(
        "/users",
        {},
        {
          enabled,
          select: (page) => page.items.map((user) => user.name).join(","),
          meta: { label: "names" },
        },
      );
      return <p>{names.data ?? "idle"}</p>;
    }
    const view = await render(within(client, <Names />));
    await settle();
    expect(view.text()).toBe("idle");
    expect(hits("GET /users")).toBe(0);
    enabled = true;
    await view.rerender(within(client, <Names />));
    await waitFor(() => expect(view.text()).toBe("Ada,Alan"));
    const [query] = client
      .getQueryCache()
      .findAll({ queryKey: ["GET /users"] });
    expect(query.meta).toEqual({ label: "names", tags: ["users"] });
  });
});

describe("useApiMutation (§7.1)", () => {
  /** A user's name, and a button renaming them through `hooks`' mutation. */
  function Rename({
    hooks = { useApi, useApiMutation },
    optimistic = false,
    fail = false,
  }: {
    hooks?: Pick<typeof bare, "useApi" | "useApiMutation">;
    optimistic?: boolean;
    fail?: boolean;
  }) {
    const user = hooks.useApi("/users/:id", { params: { id: "1" } });
    const rename = hooks.useApiMutation(
      "PATCH /users/:id",
      optimistic
        ? {
            optimistic: {
              "GET /users/:id": (old, variables) => ({
                ...old,
                name: variables.body.name,
              }),
            },
          }
        : {},
    );
    return (
      <div>
        <p>{user.data?.name ?? "loading"}</p>
        <p>{rename.status}</p>
        <button
          type="button"
          onClick={() =>
            rename.mutate({
              params: { id: "1" },
              body: { name: "Lovelace", fail },
            })
          }
        >
          rename
        </button>
      </div>
    );
  }

  it("invalidates the route's tags on success: the user re-renders with the server's answer", async () => {
    const client = newQueryClient();
    const view = await render(within(client, <Rename />));
    await waitFor(() => expect(view.text()).toBe("Adaidlerename"));
    await click(view.container.querySelector("button"));
    await waitFor(() => expect(view.text()).toBe("Lovelacesuccessrename"));
    expect(hits("GET /users/1")).toBe(2);
  });

  it("control: without the manifest's invalidates, the user keeps the old name after the mutation", async () => {
    const client = newQueryClient();
    const view = await render(within(client, <Rename hooks={bare} />));
    await waitFor(() => expect(view.text()).toBe("Adaidlerename"));
    await click(view.container.querySelector("button"));
    await waitFor(() => expect(view.text()).toBe("Adasuccessrename"));
    expect(hits("GET /users/1")).toBe(1);
  });

  it("renders the optimistic write while the request is in flight, and the rollback when it fails", async () => {
    const client = newQueryClient();
    let release!: () => void;
    state.hold = new Promise((resolve) => {
      release = resolve;
    });
    const view = await render(
      within(
        client,
        <Rename
          optimistic
          fail
        />,
      ),
    );
    await waitFor(() => expect(view.text()).toBe("Adaidlerename"));
    await click(view.container.querySelector("button"));
    await waitFor(() => expect(view.text()).toBe("Lovelacependingrename"));
    // The refetch the mutation's settling starts is held, so what renders
    // next is the rollback itself, not the server's answer.
    let releaseGet!: () => void;
    state.holdGet = new Promise((resolve) => {
      releaseGet = resolve;
    });
    release();
    await waitFor(() => expect(view.text()).toBe("Adapendingrename"));
    expect(hits("GET /users/1")).toBe(2);
    releaseGet();
    await waitFor(() => expect(view.text()).toBe("Adaerrorrename"));
    expect(state.users.get("1")!.name).toBe("Ada");
  });

  it("control: without optimistic, nothing changes on screen while the request is in flight", async () => {
    const client = newQueryClient();
    let release!: () => void;
    state.hold = new Promise((resolve) => {
      release = resolve;
    });
    const view = await render(within(client, <Rename fail />));
    await waitFor(() => expect(view.text()).toBe("Adaidlerename"));
    await click(view.container.querySelector("button"));
    await waitFor(() => expect(view.text()).toBe("Adapendingrename"));
    release();
    await waitFor(() => expect(view.text()).toBe("Adaerrorrename"));
  });

  it("runs the caller's onSuccess after the layer's invalidations: it reads the refetched data", async () => {
    const client = newQueryClient();
    const seen: unknown[] = [];
    function Probe() {
      const rename = useApiMutation(
        "PATCH /users/:id",
        {},
        {
          onSuccess: () => {
            seen.push(
              client.getQueryData(
                q.key("GET /users/:id", { params: { id: "1" } }),
              ),
            );
          },
        },
      );
      useApi("/users/:id", { params: { id: "1" } });
      return (
        <button
          type="button"
          onClick={() =>
            rename.mutate({ params: { id: "1" }, body: { name: "Lovelace" } })
          }
        >
          go
        </button>
      );
    }
    const view = await render(within(client, <Probe />));
    await waitFor(() => expect(hits("GET /users/1")).toBe(1));
    await click(view.container.querySelector("button"));
    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toEqual({ id: "1", name: "Lovelace" });
  });

  it("control: react-query's useMutation given the layer's options with its own onSuccess replacing the layer's invalidates nothing", async () => {
    const client = newQueryClient();
    const seen: unknown[] = [];
    function Probe() {
      const rename = useMutation({
        ...q.mutation("PATCH /users/:id"),
        onSuccess: () => {
          seen.push(
            client.getQueryData(
              q.key("GET /users/:id", { params: { id: "1" } }),
            ),
          );
        },
      });
      useApi("/users/:id", { params: { id: "1" } });
      return (
        <button
          type="button"
          onClick={() =>
            rename.mutate({ params: { id: "1" }, body: { name: "Lovelace" } })
          }
        >
          go
        </button>
      );
    }
    const view = await render(within(client, <Probe />));
    await waitFor(() => expect(hits("GET /users/1")).toBe(1));
    await click(view.container.querySelector("button"));
    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toEqual({ id: "1", name: "Ada" });
    await settle();
    expect(hits("GET /users/1")).toBe(1);
  });
});

describe("useApiSuspense (§7.1: the staleTime floor)", () => {
  function SuspendedName() {
    const user = useApiSuspense("/users/:id", { params: { id: "1" } });
    return <p>{user.data.name}</p>;
  }

  it("suspends, then renders the data, fetching once", async () => {
    const client = newQueryClient();
    const view = await render(
      within(
        client,
        <Suspense fallback={<p>suspended</p>}>
          <SuspendedName />
        </Suspense>,
      ),
    );
    await waitFor(() => expect(view.text()).toBe("Ada"));
    await settle();
    expect(hits("GET /users/1")).toBe(1);
  });

  it("control: the spike's Suspense without the floor (throw the fetch, then a staleTime 0 query) fetches twice", async () => {
    const client = newQueryClient();
    const options = q.query("/users/:id", { params: { id: "1" } });
    function Naive() {
      const user = useQuery({ ...options, staleTime: 0 });
      if (client.getQueryData(options.queryKey) === undefined)
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Suspense's protocol: the spike threw the pending fetch
        throw client.fetchQuery(options);
      return <p>{user.data?.name}</p>;
    }
    const view = await render(
      within(
        client,
        <Suspense fallback={<p>suspended</p>}>
          <Naive />
        </Suspense>,
      ),
    );
    await waitFor(() => expect(view.text()).toBe("Ada"));
    await settle();
    expect(hits("GET /users/1")).toBe(2);
  });
});

describe("useApiInfinite (§7.1)", () => {
  it("renders the first page, then appends the next until next gives none", async () => {
    const client = newQueryClient();
    function List() {
      const pages = useApiInfinite(
        "/users",
        {},
        { pageParam: "page", next: (last) => last.next },
      );
      const names = pages.data?.pages.flatMap((page) =>
        page.items.map((user) => user.name),
      );
      return (
        <div>
          <p>{names?.join(",") ?? "loading"}</p>
          <p>{pages.hasNextPage ? "more" : "end"}</p>
          <button
            type="button"
            onClick={() => void pages.fetchNextPage()}
          >
            next
          </button>
        </div>
      );
    }
    const view = await render(within(client, <List />));
    await waitFor(() => expect(view.text()).toBe("Ada,Alanmorenext"));
    await click(view.container.querySelector("button"));
    await waitFor(() => expect(view.text()).toBe("Ada,Alan,Graceendnext"));
    expect(hits("GET /users")).toBe(2);
  });
});

describe("StrictMode", () => {
  it("double-mounts without a second fetch, and leaves one observer per component", async () => {
    const client = newQueryClient();
    const view = await render(
      within(
        client,
        <StrictMode>
          <UserName id="1" />
        </StrictMode>,
      ),
    );
    await waitFor(() => expect(view.text()).toBe("Ada"));
    await settle();
    expect(hits("GET /users/1")).toBe(1);
    expect(observers(client)).toBe(1);
    await view.unmount();
    expect(observers(client)).toBe(0);
  });

  it("control: StrictMode does double-mount here: an effect that fetches on mount fetches twice", async () => {
    function EffectFetch() {
      useEffect(() => {
        void api.get("/users/:id", { params: { id: "1" } });
      }, []);
      return null;
    }
    await render(
      <StrictMode>
        <EffectFetch />
      </StrictMode>,
    );
    await settle();
    expect(hits("GET /users/1")).toBe(2);
  });
});
