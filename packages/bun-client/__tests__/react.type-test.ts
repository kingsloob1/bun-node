/**
 * The React binding's types (plan §7.1, §12.1's PR-C6 row): what each hook
 * takes and what its result carries, from the route map through
 * `queries()` and `createApiHooks()`. Each `@ts-expect-error` is a negative
 * control: it must error, and it must be there (an unused one fails the
 * check too). The `Expect<Equal<…>>` lines pin the types.
 *
 * Checked by `bun run check`, not by `bun test`; nothing here runs (the
 * hooks are called inside functions no one calls).
 */
import type { ClientError, HttpError, Jsonify } from "../lib/index";
import type { OptimisticSnapshot } from "../lib/query";
import type { InfiniteData } from "@tanstack/react-query";
import { z } from "zod";
import { createClient } from "../lib/index";
import { queries } from "../lib/query";
import { createApiHooks } from "../lib/react";

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
    query: { q?: string; page?: number };
    body: undefined;
    responses: { 200: Page };
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

type UserError = HttpError<Routes["GET /users/:id"]> | ClientError;

// The hooks' factory returns the four hooks, typed by the map.
export type _hooks = Expect<
  Equal<
    keyof ReturnType<typeof createApiHooks<Routes>>,
    "useApi" | "useApiSuspense" | "useApiInfinite" | "useApiMutation"
  >
>;

const q = queries(createClient<Routes>());
const { useApi, useApiSuspense, useApiInfinite, useApiMutation } =
  createApiHooks(q);

/* ---- useApi ---- */

function UseApi() {
  const user = useApi("/users/:id", { params: { id: "1" } });
  const _data: Equal<typeof user.data, Jsonify<User> | undefined> = true;
  const _error: Equal<typeof user.error, UserError | null> = true;
  if (user.isSuccess) {
    // Narrowed by react-query's result union: the data is there.
    const _name: Equal<typeof user.data.name, string> = true;
    // A Date crossed the wire as a string.
    const _at: Equal<typeof user.data.createdAt, string> = true;
    void _name;
    void _at;
  }
  if (user.isError && user.error instanceof Error && "body" in user.error) {
    void user.error;
  }

  // A route with no required part takes no options.
  const list = useApi("/users");
  const _list: Equal<typeof list.data, Jsonify<Page> | undefined> = true;

  // react-query's options pass through; `select` types the data.
  const names = useApi(
    "/users",
    { query: { q: "a" } },
    {
      staleTime: 60_000,
      select: (page) => page.items.map((item) => item.name),
    },
  );
  const _names: Equal<typeof names.data, string[] | undefined> = true;
  void [_data, _error, _list, _names, list, names];

  // @ts-expect-error a path the map does not have
  useApi("/nope");
  // @ts-expect-error a POST route is not a query
  useApi("/users/:id/x");
  // @ts-expect-error the params are required
  useApi("/users/:id");
  // @ts-expect-error a param of the wrong type
  useApi("/users/:id", { params: { id: 1 } });
  // @ts-expect-error a param the route does not have
  useApi("/users/:id", { params: { id: "1", org: "2" } });
  // @ts-expect-error a query field the route does not declare
  useApi("/users/:id", { params: { id: "1" }, query: { page: 1 } });
  // @ts-expect-error a query field of the wrong type
  useApi("/users", { query: { page: "1" } });
  // @ts-expect-error the key comes from the route
  useApi("/users", {}, { queryKey: ["x"] });
  // @ts-expect-error the query function comes from the route
  useApi("/users", {}, { queryFn: () => 1 });
  // @ts-expect-error `select` receives the route's data
  useApi("/users", {}, { select: (page: { other: number }) => page.other });
  // @ts-expect-error control: the data is the route's, not another's
  const _wrong: Equal<typeof user.data, Jsonify<Page> | undefined> = true;
  void _wrong;
}
void UseApi;

/* ---- useApiSuspense ---- */

function UseApiSuspense() {
  const user = useApiSuspense("/users/:id", { params: { id: "1" } });
  // Suspense: the data is always defined.
  const _data: Equal<typeof user.data, Jsonify<User>> = true;
  const _error: Equal<typeof user.error, UserError | null> = true;
  const named = useApiSuspense(
    "/users/:id",
    { params: { id: "1" } },
    { select: (found) => found.name },
  );
  const _named: Equal<typeof named.data, string> = true;
  void [_data, _error, _named, user, named];
  // @ts-expect-error the params are required
  useApiSuspense("/users/:id");
  // @ts-expect-error Suspense queries cannot be disabled
  useApiSuspense("/users", {}, { enabled: false });
}
void UseApiSuspense;

/* ---- useApiInfinite ---- */

function UseApiInfinite() {
  const pages = useApiInfinite(
    "/users",
    { query: { q: "a" } },
    { pageParam: "page", next: (last) => last.next },
  );
  const _pages: Equal<
    typeof pages.data,
    InfiniteData<Jsonify<Page>, number | undefined> | undefined
  > = true;
  const _error: Equal<
    typeof pages.error,
    HttpError<Routes["GET /users"]> | ClientError | null
  > = true;
  void [_pages, _error];
  void pages.fetchNextPage();
  // react-query's options pass through.
  useApiInfinite(
    "/users",
    {},
    { pageParam: "page", next: () => undefined },
    { staleTime: 1000, maxPages: 3 },
  );
  // @ts-expect-error the page field must be one of the route's query fields
  useApiInfinite("/users", {}, { pageParam: "offset", next: () => undefined });
  useApiInfinite(
    "/users",
    {},
    {
      pageParam: "page",
      // @ts-expect-error `next` gives the page field's type: a number here
      next: () => "2",
    },
  );
  useApiInfinite(
    "/users",
    {},
    { pageParam: "page", next: () => undefined },
    // @ts-expect-error the paging comes from the third argument
    { getNextPageParam: () => 2 },
  );
}
void UseApiInfinite;

/* ---- useApiMutation ---- */

function UseApiMutation() {
  const create = useApiMutation("POST /users");
  const _data: Equal<typeof create.data, Jsonify<User> | undefined> = true;
  const _error: Equal<
    typeof create.error,
    HttpError<Routes["POST /users"]> | ClientError | null
  > = true;
  const _context: Equal<typeof create.context, OptimisticSnapshot | undefined> =
    true;
  void [_data, _error, _context];
  create.mutate({ body: { name: "Ada" } });
  // @ts-expect-error the body is required
  create.mutate({});
  // @ts-expect-error a body field of the wrong type
  create.mutate({ body: { name: 1 } });
  // @ts-expect-error a route key the map does not have
  useApiMutation("PUT /users/:id");

  const rename = useApiMutation(
    "PATCH /users/:id",
    {
      optimistic: {
        "GET /users/:id": (old, variables) => ({
          ...old,
          name: variables.body.name,
        }),
      },
    },
    {
      onSuccess: (user, variables, snapshot) => {
        const _user: Equal<typeof user, Jsonify<User>> = true;
        const _id: Equal<typeof variables.params.id, string> = true;
        // What the optimistic writes saved, as onMutate resolved it.
        const _snapshot: Equal<typeof snapshot, OptimisticSnapshot> = true;
        void [_user, _id, _snapshot, snapshot];
      },
    },
  );
  rename.mutate({ params: { id: "1" }, body: { name: "Ada" } });
  useApiMutation("PATCH /users/:id", {
    optimistic: {
      // @ts-expect-error a writer returns the route's data
      "GET /users/:id": () => ({ id: 1 }),
    },
  });
  useApiMutation(
    "PATCH /users/:id",
    {},
    // @ts-expect-error onMutate is the optimistic writers'
    { onMutate: () => undefined },
  );
  useApiMutation("DELETE /users/:id").mutate({ params: { id: "1" } });
}
void UseApiMutation;

/* ---- BYO response types (§5.4) ---- */

const UserWithDate = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime().transform((at) => new Date(at)),
});
type Parsed = z.output<typeof UserWithDate>;
const byo = { response: { 200: { custom: UserWithDate } } } as const;

function UseApiByo() {
  const _one = useApi("/users/:id", { params: { id: "1" }, validate: byo });
  type _oneType = Expect<Equal<typeof _one.data, Parsed | undefined>>;
  // `select` reads the BYO output.
  const _at = useApi(
    "/users/:id",
    { params: { id: "1" }, validate: byo },
    { select: (user) => user.createdAt },
  );
  type _atType = Expect<Equal<typeof _at.data, Date | undefined>>;
  const _suspended = useApiSuspense("/users/:id", {
    params: { id: "1" },
    validate: byo,
  });
  type _suspendedType = Expect<Equal<typeof _suspended.data, Parsed>>;
  // Control: without it, the wire type.
  const _wire = useApi("/users/:id", { params: { id: "1" } });
  type _wireType = Expect<Equal<typeof _wire.data, Jsonify<User> | undefined>>;
  // @ts-expect-error the wire's createdAt is a string, not the BYO Date
  type _wireIsParsed = Expect<Equal<typeof _wire.data, Parsed | undefined>>;
  const _pages = useApiInfinite(
    "/users",
    {
      validate: {
        response: {
          200: {
            custom: z.object({
              items: z.array(UserWithDate),
              next: z.number().nullable(),
            }),
          },
        },
      },
    },
    { pageParam: "page", next: (last) => last.next },
  );
  type _pagesType = Expect<
    Equal<
      NonNullable<typeof _pages.data>["pages"][number]["items"][number],
      Parsed
    >
  >;
  const _created = useApiMutation("POST /users", {
    validate: { response: { 201: { custom: UserWithDate } } },
  });
  type _createdType = Expect<Equal<typeof _created.data, Parsed | undefined>>;
}
void UseApiByo;
