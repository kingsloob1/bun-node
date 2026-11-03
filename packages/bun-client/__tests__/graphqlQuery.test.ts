/**
 * The query layer's GraphQL queries (`q.graphql()`, `graphql.md` §3.1,
 * PR-G1) against the hand-written GraphQL endpoint: the key `[url,
 * operationName, variables]` (an anonymous operation's text in its name's
 * place), the query function resolving `data`, rejecting with
 * `GraphQLResponseError` for errors and the client's `HttpError` for a
 * failed status, `tags` as `meta.tags` with `invalidateTags`, and the
 * responses' `Cache-Tag` kept as the route queries' are. Each behaviour has
 * a negative control beside it.
 */
import type { TypedString } from "../lib/graphql";
import type { QueryKey } from "@tanstack/query-core";
import type { SeenRequest } from "./fixtures/graphql-endpoint";
import { QueryClient } from "@tanstack/query-core";
import { describe, expect, it } from "bun:test";
import { createGraphQLClient, GraphQLResponseError } from "../lib/graphql";
import { createClient, HttpError } from "../lib/index";
import { invalidateTags, queries, tagsOfQuery } from "../lib/query";
import { graphqlEndpoint } from "./fixtures/graphql-endpoint";

/** What the `User` operation answers. */
interface UserData {
  user: { id: string; name: string } | null;
}

const UserQuery =
  `query User($id: ID!) { user(id: $id) { id name } }` as TypedString<
    UserData,
    { id: string }
  >;

/** A client, its GraphQL client, the query layer and a fresh QueryClient over the endpoint. */
function setup(headers: Record<string, string> = {}) {
  const server = graphqlEndpoint({
    operations: {
      User: (request: SeenRequest) => {
        const { id } = request.variables as { id: string };
        if (id === "missing")
          return {
            body: {
              data: { user: null },
              errors: [{ message: "No user missing", path: ["user"] }],
            },
          };
        if (id === "bad")
          return { status: 400, body: { errors: [{ message: "bad" }] } };
        return {
          body: { data: { user: { id, name: `user ${id}` } } },
          headers,
        };
      },
      "": () => ({ body: { data: { me: "x" } } }),
    },
  });
  const api = createClient({ fetch: server.fetch, retry: false });
  const gh = createGraphQLClient({ client: api, url: "/graphql" });
  const q = queries(api);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { server, gh, q, queryClient };
}

describe("q.graphql()", () => {
  it("keys a query [url, operationName, variables] and resolves its data", async () => {
    const { server, gh, q, queryClient } = setup();
    const options = q.graphql(gh, UserQuery, { id: "7" });
    expect(options.queryKey as QueryKey).toEqual([
      "/graphql",
      "User",
      { id: "7" },
    ]);
    const data = await queryClient.fetchQuery(options);
    expect(data).toEqual({ user: { id: "7", name: "user 7" } });
    expect(queryClient.getQueryData(options.queryKey)?.user?.id).toBe("7");
    expect(server.seen.length).toBe(1);
    // A second fetch within staleTime is the cache's.
    await queryClient.fetchQuery({ ...options, staleTime: 60_000 });
    expect(server.seen.length).toBe(1);
  });

  it("keys an anonymous operation by its text, and absent variables as {}", () => {
    const { gh, q } = setup();
    expect(q.graphql(gh, "{ me }").queryKey as QueryKey).toEqual([
      "/graphql",
      "{ me }",
      {},
    ]);
    expect(q.graphql(gh, "{ you }").queryKey as QueryKey).not.toEqual(
      q.graphql(gh, "{ me }").queryKey as QueryKey,
    );
  });

  it("rejects with GraphQLResponseError for errors (the partial data on it), and the client's HttpError for a failed status", async () => {
    const { gh, q, queryClient } = setup();
    const partial = await queryClient
      .fetchQuery(q.graphql(gh, UserQuery, { id: "missing" }))
      .catch((error: unknown) => error);
    expect(partial).toBeInstanceOf(GraphQLResponseError);
    expect((partial as GraphQLResponseError).data).toEqual({ user: null });
    const failed = await queryClient
      .fetchQuery(q.graphql(gh, UserQuery, { id: "bad" }))
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(HttpError);
    expect((failed as HttpError).status).toBe(400);
  });

  it("puts tags in meta.tags, which invalidateTags matches", async () => {
    const { server, gh, q, queryClient } = setup();
    const tagged = q.graphql(gh, UserQuery, { id: "1" }, { tags: ["user:1"] });
    const other = q.graphql(gh, UserQuery, { id: "2" });
    expect(tagged.meta.tags).toEqual(["user:1"]);
    expect(other.meta.tags).toEqual([]);
    await queryClient.fetchQuery(tagged);
    await queryClient.fetchQuery(other);
    await invalidateTags(queryClient, ["user:1"]);
    expect(queryClient.getQueryState(tagged.queryKey)?.isInvalidated).toBe(
      true,
    );
    // Negative control: the untagged query is untouched.
    expect(queryClient.getQueryState(other.queryKey)?.isInvalidated).toBe(
      false,
    );
    expect(server.seen.length).toBe(2);
  });

  it("keeps its responses' Cache-Tag as a route query's are", async () => {
    const tagged = setup({ "cache-tag": "user:5, org:1" });
    const options = tagged.q.graphql(tagged.gh, UserQuery, { id: "5" });
    await tagged.queryClient.fetchQuery(options);
    const query = tagged.queryClient
      .getQueryCache()
      .find({ queryKey: options.queryKey, exact: true })!;
    expect(tagsOfQuery(tagged.queryClient, query).sort()).toEqual([
      "org:1",
      "user:5",
    ]);
    // Negative control: no header, no tags.
    const plain = setup();
    const bare = plain.q.graphql(plain.gh, UserQuery, { id: "5" });
    await plain.queryClient.fetchQuery(bare);
    const untagged = plain.queryClient
      .getQueryCache()
      .find({ queryKey: bare.queryKey, exact: true })!;
    expect(tagsOfQuery(plain.queryClient, untagged)).toEqual([]);
  });

  it("passes the call's options through, and query-core's signal", async () => {
    const { server, gh, q, queryClient } = setup();
    await queryClient.fetchQuery(
      q.graphql(
        gh,
        UserQuery,
        { id: "1" },
        { headers: { "x-call": "1" }, method: "GET" },
      ),
    );
    expect(server.seen[0].method).toBe("GET");
    expect(server.seen[0].headers.get("x-call")).toBe("1");
  });

  it("refuses an object that is not a GraphQL client", () => {
    const { q } = setup();
    expect(() =>
      q.graphql({ query: async () => undefined }, UserQuery, { id: "1" }),
    ).toThrow(TypeError);
  });
});
