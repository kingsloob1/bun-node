/**
 * A typed GraphQL operation through the client — `createGraphQLClient` from
 * `@kingsleyweb/bun-client/graphql` sends one typed call over the HTTP
 * client's own request path, and `q.graphql()` puts it in the query layer.
 * Each behaviour is asserted.
 *
 * ```bash
 * bun 14-typed-client/graphql.ts
 * ```
 *
 * - **bun-node serves no GraphQL.** The "server" below is a few lines that
 *   answer two operations by hand, standing in for someone else's API; the
 *   client is the point. No GraphQL library is a dependency of the client or
 *   of this example.
 * - **Documents are typed by your own tooling.** gql.tada's `graphql()` or
 *   graphql-codegen's client preset emit a `TypedDocumentNode`; the client
 *   reads the result and variables off its `__apiType` phantom. Here the
 *   same is written by hand as a `TypedString<Result, Variables>`, the type
 *   the tools' string documents have.
 * - **Results are discriminated**: `ok` and no `errors` means complete
 *   `data`; `ok` with `errors` means partial data; `!ok` is a failed status.
 *   `throwOnGraphQLErrors` turns the second into a thrown
 *   `GraphQLResponseError`.
 * - **Through the client**: base URL, headers and auth apply, a query is
 *   retried as an idempotent request, a mutation never is.
 */
import type { TypedString } from "@kingsleyweb/bun-client/graphql";
import { createClient } from "@kingsleyweb/bun-client";
import {
  createGraphQLClient,
  GraphQLResponseError,
} from "@kingsleyweb/bun-client/graphql";
import {
  invalidateTags,
  observe,
  queries,
} from "@kingsleyweb/bun-client/query";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { QueryClient } from "@tanstack/query-core";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("A typed GraphQL operation");

/** The result and variables of the two operations: what a codegen tool would emit. */
interface UserData {
  user: { id: string; name: string } | null;
}
interface RenameData {
  rename: { id: string; name: string };
}

const UserQuery =
  "query User($id: ID!) { user(id: $id) { id name } }" as TypedString<
    UserData,
    { id: string }
  >;
const Rename =
  "mutation Rename($id: ID!, $name: String!) { rename(id: $id, name: $name) { id name } }" as TypedString<
    RenameData,
    { id: string; name: string }
  >;

/* ------------------------------------------------------------------ */
step("A stand-in GraphQL server (GraphQL over HTTP, by hand)");

const names = new Map([["1", "Ada"]]);
/** What reached the endpoint: the method, the Accept header and the parsed request. */
const seen: {
  method: string;
  accept: string | null;
  operationName?: string;
  variables?: Record<string, string>;
}[] = [];

const adapter = new BunHttpAdapter(0, { logger: noopLogger });
/** Answers one GraphQL request body. */
const execute = (request: {
  operationName?: string;
  variables?: Record<string, string>;
}) => {
  const { operationName, variables = {} } = request;
  if (operationName === "User") {
    const name = names.get(variables.id ?? "");
    return name === undefined
      ? {
          data: { user: null },
          errors: [{ message: "No user with that id", path: ["user"] }],
        } // partial: data and errors
      : { data: { user: { id: variables.id, name } } };
  }
  if (operationName === "Rename") {
    names.set(variables.id ?? "", variables.name ?? "");
    return { data: { rename: { id: variables.id, name: variables.name } } };
  }
  return undefined;
};
adapter.post("/graphql", (req, res) => {
  const body = req.body as {
    operationName?: string;
    variables?: Record<string, string>;
  };
  seen.push({ method: "POST", accept: req.get("accept") ?? null, ...body });
  const answer = execute(body);
  // A request it cannot run is a 4xx, as GraphQL over HTTP says.
  if (answer === undefined)
    res.status(400).json({ errors: [{ message: "Unknown operation" }] });
  else res.json(answer);
});
adapter.get("/graphql", (req, res) => {
  const query = req.query as { operationName?: string; variables?: string };
  const body = {
    operationName: query.operationName,
    variables:
      query.variables === undefined
        ? {}
        : (JSON.parse(query.variables) as Record<string, string>),
  };
  seen.push({ method: "GET", accept: req.get("accept") ?? null, ...body });
  res.json(execute(body) ?? {});
});
const server = await adapter.listen(0);

try {
  const api = createClient({ baseUrl: `http://127.0.0.1:${server.port}` });
  const gh = createGraphQLClient({ client: api, url: "/graphql" });

  /* ---------------------------------------------------------------- */
  step("A query: complete data, partial data, a failed status");

  const complete = await gh.query(UserQuery, { id: "1" });
  if (complete.ok && !complete.errors) {
    // No `errors`: `data` is the complete result, typed by the document.
    checkEqual(
      "complete data, typed by the document",
      complete.data.user?.name,
      "Ada",
    );
  } else {
    check("a complete result", false, complete);
  }
  check(
    "it asked for application/graphql-response+json first",
    seen[0]?.accept?.startsWith("application/graphql-response+json") === true,
    seen[0],
  );

  const partial = await gh.query(UserQuery, { id: "404" });
  if (partial.ok && partial.errors) {
    show("errors", partial.errors);
    checkEqual(
      "ok with errors: the data is partial (here null)",
      [partial.data?.user ?? null, partial.errors[0]?.message],
      [null, "No user with that id"],
    );
  } else {
    check("a partial result", false, partial);
  }

  const failed = await gh.query("query Nope { nope }");
  checkEqual(
    "an untyped string document still works; its data is unknown, and a 400 is a failed result",
    [failed.ok, failed.status],
    [false, 400],
  );

  /* ---------------------------------------------------------------- */
  step("A mutation, a GET query, and throwing on GraphQL errors");

  const renamed = await gh.mutate(Rename, { id: "1", name: "Ada Lovelace" });
  checkEqual(
    "the mutation's data is typed too",
    renamed.ok && !renamed.errors && renamed.data.rename.name,
    "Ada Lovelace",
  );

  const viaGet = await gh.query(UserQuery, { id: "1" }, { method: "GET" });
  checkEqual(
    "method: GET sends the query in the URL",
    seen.at(-1)?.method,
    "GET",
  );
  checkEqual(
    "and reads the renamed user",
    viaGet.ok && viaGet.data?.user?.name,
    "Ada Lovelace",
  );

  const strict = createGraphQLClient({
    client: api,
    url: "/graphql",
    throwOnGraphQLErrors: true,
  });
  const error = await checkRejects(
    "throwOnGraphQLErrors: errors throw",
    () => strict.query(UserQuery, { id: "404" }),
    { name: "GraphQLResponseError" },
  );
  check(
    "the GraphQLResponseError carries the errors",
    error instanceof GraphQLResponseError && error.errors.length === 1,
    error,
  );

  /* ---------------------------------------------------------------- */
  step("In the query layer: q.graphql() and cache tags");

  const q = queries(api);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const user = q.graphql(gh, UserQuery, { id: "1" }, { tags: ["user:1"] });
  const first = await queryClient.fetchQuery(user);
  checkEqual(
    "fetchQuery resolves the operation's data",
    first.user?.name,
    "Ada Lovelace",
  );
  show("key", user.queryKey);
  checkEqual(
    "the key is [url, operationName, variables]",
    [user.queryKey[0], user.queryKey[1], user.queryKey[2]],
    ["/graphql", "User", { id: "1" }],
  );

  const calls = seen.length;
  await queryClient.fetchQuery(user);
  checkEqual("a second fetch is served from the cache", seen.length, calls);
  names.set("1", "Ada, renamed elsewhere");
  // query-core refetches the queries somebody observes.
  const stop = observe(queryClient, user).subscribe(() => undefined);
  await invalidateTags(queryClient, ["user:1"]);
  checkEqual(
    "invalidateTags(['user:1']) refetches it",
    queryClient.getQueryData(user.queryKey)?.user?.name,
    "Ada, renamed elsewhere",
  );
  stop();
  queryClient.clear();

  /* ---------------------------------------------------------------- */
  step("The type-level half");

  const refused = async (): Promise<void> => {
    // @ts-expect-error -- `id` is required by the document's variables
    await gh.query(UserQuery, {});
    // @ts-expect-error -- `id` is a string
    await gh.query(UserQuery, { id: 1 });
    // @ts-expect-error -- Rename's variables need `name`
    await gh.mutate(Rename, { id: "1" });
    const r = await gh.query(UserQuery, { id: "1" });
    // @ts-expect-error -- `data` exists only once `r.ok` has narrowed the result
    void r.data.user;
    if (r.ok && !r.errors) {
      // @ts-expect-error -- the document selects `id` and `name`, not `email`
      void r.data.user?.email;
    }
  };
  void refused;
  show("five refusals at compile time (see the source)");
} finally {
  await adapter.close();
}

summary();
