/**
 * The query layer's types (plan §6.4, §12.1's PR-C5 row): what each factory
 * takes and what its options carry into query-core. Each `@ts-expect-error`
 * is a negative control: it must error, and it must be there (an unused one
 * fails the check too). The `Expect<Equal<…>>` lines pin the types.
 *
 * Checked by `bun run check`, not by `bun test`; nothing here runs.
 */
import type { ClientError, HttpError, Jsonify } from "../lib/index";
import type {
  InfiniteQuerySnapshot,
  OptimisticSnapshot,
  QuerySnapshot,
} from "../lib/query";
import type { InfiniteData } from "@tanstack/query-core";
import { MutationObserver, QueryClient } from "@tanstack/query-core";
import { createClient } from "../lib/index";
import { invalidateTags, observe, queries } from "../lib/query";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

interface User {
  id: string;
  name: string;
  createdAt: Date;
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
    query: { q?: string; page?: number; cursor?: string };
    body: undefined;
    responses: { 200: Page };
  };
  "GET /search": {
    params: Record<never, never>;
    query: { term: string; page?: number };
    body: undefined;
    responses: { 200: Page };
  };
  "GET /feed": {
    params: Record<never, never>;
    query: { cursor: string; size?: number };
    body: undefined;
    responses: { 200: { items: string[]; cursor: string | null } };
  };
  "POST /users": {
    params: Record<never, never>;
    query: Record<never, never>;
    body: { name: string };
    responses: { 201: User; 409: { code: "CONFLICT" } };
  };
  "PATCH /users/:id": {
    params: { id: string };
    query: Record<never, never>;
    body: { name: string };
    responses: { 200: User };
  };
  "DELETE /users/:id": {
    params: { id: string };
    responses: { 204: undefined };
  };
}

const api = createClient<Routes>({
  manifest: { "GET /users/:id": { cache: { tags: ["user:{id}"] } } },
});
const q = queries(api, {
  manifest: { "GET /users/:id": { cache: { tags: ["user:{id}"] } } },
});
const client = new QueryClient();

/* ---- q.query ---- */

const user = q.query("/users/:id", { params: { id: "1" } });
export type _userData = Expect<
  Equal<Awaited<ReturnType<typeof user.queryFn>>, Jsonify<User>>
>;
// The key is tagged with the data: getQueryData reads it typed.
export type _cached = Expect<
  Equal<
    ReturnType<typeof client.getQueryData<Jsonify<User>, typeof user.queryKey>>,
    Jsonify<User> | undefined
  >
>;
const _cachedUser = client.getQueryData(user.queryKey);
export type _cachedInferred = Expect<
  Equal<typeof _cachedUser, Jsonify<User> | undefined>
>;
async function fetches() {
  const _fetchedValue = await client.fetchQuery(user);
  const _fetched: Equal<typeof _fetchedValue, Jsonify<User>> = true;
  void _fetched;
  // A query of a route with no required part takes no options.
  const _listValue = await client.fetchQuery(q.query("/users"));
  const _list: Equal<typeof _listValue, Jsonify<Page>> = true;
  void _list;
}
void fetches;

// @ts-expect-error a path the map does not have
q.query("/nope");
// @ts-expect-error a POST route is not a query
q.query("/users/:id/x");
// @ts-expect-error the params are required
q.query("/users/:id");
// @ts-expect-error a param of the wrong type
q.query("/users/:id", { params: { id: 1 } });
// @ts-expect-error a query field the route does not declare
q.query("/users/:id", { params: { id: "1" }, query: { page: 1 } });
// @ts-expect-error no signal: query-core's is used
q.query("/users", { signal: new AbortController().signal });
// @ts-expect-error no throwOnError: a query function always throws on failure
q.query("/users", { throwOnError: false });
// Per-route settings pass through.
q.query("/users", { timeout: 1000, retry: false });

/* ---- keys ---- */

q.key("GET /users/:id");
q.key("GET /users/:id", { params: { id: "1" } });
// @ts-expect-error a route key the map does not have
q.key("GET /nope");

/* ---- q.infinite ---- */

const pages = q.infinite(
  "/users",
  { query: { q: "a" } },
  { pageParam: "page", next: (last) => last.next ?? undefined },
);
const _infiniteData = client.getQueryData(pages.queryKey);
export type _infinite = Expect<
  Equal<
    typeof _infiniteData,
    InfiniteData<Jsonify<Page>, number | undefined> | undefined
  >
>;
// A string cursor is typed as the cursor field is.
q.infinite(
  "/users",
  {},
  {
    pageParam: "cursor",
    initialPageParam: "start",
    next: (last) => (last.next === null ? undefined : String(last.next)),
  },
);
// The page field may be left out of the query, the other required fields not.
q.infinite(
  "/search",
  { query: { term: "x" } },
  { pageParam: "page", next: () => undefined },
);
// A required page field too: the pages supply it.
q.infinite(
  "/feed",
  {},
  {
    pageParam: "cursor",
    initialPageParam: "",
    next: (last) => last.cursor ?? undefined,
  },
);
q.infinite(
  "/search",
  // @ts-expect-error `term` is still required
  { query: {} },
  { pageParam: "page", next: () => undefined },
);
// @ts-expect-error the page field must be one of the route's query fields
q.infinite("/users", {}, { pageParam: "offset", next: () => undefined });
q.infinite(
  "/users",
  {},
  {
    pageParam: "page",
    // @ts-expect-error `next` gives the page field's type: a number here
    next: () => "2",
  },
);
q.infinite(
  "/users",
  {},
  // @ts-expect-error `initialPageParam` is the page field's type
  { pageParam: "page", initialPageParam: "1", next: () => undefined },
);

/* ---- q.mutation ---- */

const create = new MutationObserver(client, q.mutation("POST /users"));
async function mutates() {
  const _createdValue = await create.mutate({ body: { name: "Ada" } });
  const _created: Equal<typeof _createdValue, Jsonify<User>> = true;
  void _created;
  // @ts-expect-error the body is required
  await create.mutate({});
  // @ts-expect-error a body field of the wrong type
  await create.mutate({ body: { name: 1 } });
  // A route with nothing required mutates with no variables.
  await new MutationObserver(client, q.mutation("DELETE /users/:id")).mutate({
    params: { id: "1" },
  });
}
void mutates;

q.mutation("PATCH /users/:id", {
  optimistic: {
    "GET /users/:id": (old, variables) => {
      const _old: Equal<typeof old, Jsonify<User>> = true;
      const _name: Equal<typeof variables.body.name, string> = true;
      void _old;
      void _name;
      return { ...old, name: variables.body.name };
    },
    "GET /users": (old) => old,
  },
});
q.mutation("PATCH /users/:id", {
  optimistic: {
    // @ts-expect-error a route the map does not have
    "GET /nope": (old: unknown) => old,
  },
});
q.mutation("PATCH /users/:id", {
  optimistic: {
    // @ts-expect-error a writer returns the route's data
    "GET /users/:id": () => ({ id: 1 }),
  },
});
// @ts-expect-error a route key the map does not have
q.mutation("PUT /users/:id");
export type _snapshot = Expect<
  Equal<
    Parameters<ReturnType<typeof q.mutation<"POST /users">>["onError"]>[2],
    OptimisticSnapshot | undefined
  >
>;

/* ---- invalidateTags ---- */

void invalidateTags(client, ["user:1"]);
void q.invalidateTags(client, ["users"], { refetchType: "all" });
// @ts-expect-error tags are strings
void invalidateTags(client, [1]);

/* ---- observe ---- */

const observed = observe(client, user);
export type _observed = Expect<
  Equal<
    ReturnType<typeof observed.getSnapshot>,
    QuerySnapshot<
      Jsonify<User>,
      HttpError<Routes["GET /users/:id"]> | ClientError
    >
  >
>;
// query-core's options spread over the factory's.
observe(client, { ...user, staleTime: 1000 });
const observedPages = observe(client, pages);
export type _observedPages = Expect<
  Equal<
    ReturnType<typeof observedPages.getSnapshot>,
    InfiniteQuerySnapshot<
      InfiniteData<Jsonify<Page>, number | undefined>,
      HttpError<Routes["GET /users"]> | ClientError
    >
  >
>;
void observedPages.fetchNextPage();
// @ts-expect-error a plain query has no pages
void observed.fetchNextPage();
