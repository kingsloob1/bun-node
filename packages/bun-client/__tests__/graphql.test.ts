/**
 * `./graphql` (`graphql.md` §3.1, PR-G1): a typed GraphQL call over the
 * client's own request path, against a hand-written GraphQL-over-HTTP
 * endpoint (`fixtures/graphql-endpoint.ts`) run in process through the
 * client's `fetch`, and once on a real server on port 0.
 *
 * What it proves: the request as the spec has it (`POST` JSON, the
 * `Accept`, `GET` parameters); every document form (a string, a `String`
 * object as codegen's `TypedDocumentString`, a parsed document with `loc`,
 * one printed by the app's `print`, one that can be neither); the results
 * (complete, partial with errors, a request error's status, a body that is
 * not GraphQL) and both throw switches at both levels; the client's request
 * path (base URL, headers, auth refresh, middleware, retries for queries
 * only, timeout, abort); the operation-type guard; and the BYO result
 * schema through the client's checks.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-contract";
import type { TypedDocumentNode, TypedString } from "../lib/graphql";
import type { Answer, SeenRequest } from "./fixtures/graphql-endpoint";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createGraphQLClient, GraphQLResponseError } from "../lib/graphql";
import {
  ClientError,
  createClient,
  HttpError,
  TimeoutError,
  ValidationError,
} from "../lib/index";
import { graphqlEndpoint } from "./fixtures/graphql-endpoint";

/** What the `User` operation answers. */
interface UserData {
  user: { id: string; name: string } | null;
}

const USER = `query User($id: ID!) { user(id: $id) { id name } }`;
const UserQuery = USER as TypedString<UserData, { id: string }>;
const RENAME = `mutation Rename($id: ID!, $name: String!) { rename(id: $id, name: $name) { id name } }`;
const Rename = RENAME as TypedString<
  { rename: { id: string; name: string } },
  { id: string; name: string }
>;

/** The `User` resolver: a user, a field error for `"missing"`. */
const user = (request: SeenRequest): Answer => {
  const { id } = request.variables as { id: string };
  return id === "missing"
    ? {
        body: {
          data: { user: null },
          errors: [{ message: "No user missing", path: ["user"] }],
          extensions: { cost: 1 },
        },
      }
    : { body: { data: { user: { id, name: `user ${id}` } } } };
};

/** An endpoint with the operations most tests use. */
function endpoint(
  extra: Record<string, (r: SeenRequest, n: number) => Answer> = {},
) {
  return graphqlEndpoint({
    operations: {
      User: user,
      Rename: (request) => {
        const { id, name } = request.variables as { id: string; name: string };
        return { body: { data: { rename: { id, name } } } };
      },
      ...extra,
    },
  });
}

// Retry notes go to the logger's `debug`; keep them out of the output.
let quiet: { mockRestore: () => void } | undefined;
beforeAll(() => {
  quiet = spyOn(console, "debug").mockImplementation(() => {});
});
afterAll(() => quiet?.mockRestore());

/** No jitter and short waits, so a retried test is quick. */
const FAST = { baseMs: 1, maxMs: 5, jitter: 0 };

describe("the request (GraphQL over HTTP)", () => {
  it("POSTs { query, variables, operationName } as JSON, asking for application/graphql-response+json", async () => {
    const server = endpoint();
    const api = createClient({
      baseUrl: "https://api.example",
      fetch: server.fetch,
    });
    const gh = createGraphQLClient({ client: api, url: "/graphql" });
    const r = await gh.query(UserQuery, { id: "7" });
    expect(r.ok && !r.errors && r.data.user).toEqual({
      id: "7",
      name: "user 7",
    });
    const [seen] = server.seen;
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("https://api.example/graphql");
    expect(JSON.parse(seen.body)).toEqual({
      query: USER,
      variables: { id: "7" },
      operationName: "User",
    });
    expect(seen.headers.get("content-type")).toBe("application/json");
    expect(seen.headers.get("accept")).toBe(
      "application/graphql-response+json, application/json;q=0.9",
    );
  });

  it("leaves out absent variables and the name of an anonymous operation", async () => {
    const server = graphqlEndpoint({
      operations: { "": () => ({ body: { data: { me: "x" } } }) },
    });
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/graphql",
    });
    await gh.query("{ me }");
    await gh.query("query { me }");
    expect(server.seen.map((seen) => JSON.parse(seen.body))).toEqual([
      { query: "{ me }" },
      { query: "query { me }" },
    ]);
  });

  it("sends a query as a GET when asked, at the client or the call, with variables JSON-encoded; a mutation stays a POST", async () => {
    const server = endpoint();
    const api = createClient({ fetch: server.fetch });
    const viaGet = createGraphQLClient({
      client: api,
      url: "/graphql",
      method: "GET",
    });
    const r = await viaGet.query(UserQuery, { id: "1" });
    expect(r.ok).toBe(true);
    const url = new URL(server.seen[0].url);
    expect(server.seen[0].method).toBe("GET");
    expect(url.pathname).toBe("/graphql");
    expect(url.searchParams.get("query")).toBe(USER);
    expect(url.searchParams.get("variables")).toBe('{"id":"1"}');
    expect(url.searchParams.get("operationName")).toBe("User");
    expect(server.seen[0].headers.get("content-type")).toBeNull();

    await viaGet.mutate(Rename, { id: "1", name: "Ada" });
    expect(server.seen[1].method).toBe("POST");

    const viaPost = createGraphQLClient({ client: api, url: "/graphql" });
    await viaPost.query(UserQuery, { id: "2" }, { method: "GET" });
    expect(server.seen[2].method).toBe("GET");
    await viaGet.query(UserQuery, { id: "3" }, { method: "POST" });
    expect(server.seen[3].method).toBe("POST");
  });

  it("keeps the endpoint URL's own query, for a POST and merged into a GET's", async () => {
    const server = endpoint();
    const api = createClient({ fetch: server.fetch });
    const gh = createGraphQLClient({
      client: api,
      url: "/graphql?tenant=a&tag=x&tag=y",
    });
    await gh.query(UserQuery, { id: "1" });
    await gh.query(UserQuery, { id: "1" }, { method: "GET" });
    const post = new URL(server.seen[0].url);
    const get = new URL(server.seen[1].url);
    expect(post.search).toBe("?tenant=a&tag=x&tag=y");
    expect(get.searchParams.get("tenant")).toBe("a");
    expect(get.searchParams.getAll("tag")).toEqual(["x", "y"]);
    expect(get.searchParams.get("operationName")).toBe("User");
  });

  it("takes an absolute URL with no baseUrl, or one under the baseUrl, and refuses one outside it", async () => {
    const server = endpoint();
    const bare = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "https://gql.example:8443/v1:graphql",
    });
    await bare.query(UserQuery, { id: "1" });
    expect(server.seen[0].url).toBe("https://gql.example:8443/v1:graphql");

    const based = createClient({
      baseUrl: "https://api.example/v2",
      fetch: server.fetch,
    });
    const under = createGraphQLClient({
      client: based,
      url: "https://api.example/v2/graphql",
    });
    await under.query(UserQuery, { id: "1" });
    expect(server.seen[1].url).toBe("https://api.example/v2/graphql");

    expect(() =>
      createGraphQLClient({
        client: based,
        url: "https://elsewhere.example/graphql",
      }),
    ).toThrow(ClientError);
  });

  it("works over a real socket (Bun.serve on port 0)", async () => {
    const server = endpoint();
    const served = Bun.serve({ port: 0, fetch: server.fetch });
    try {
      const gh = createGraphQLClient({
        client: createClient({ baseUrl: served.url.origin }),
        url: "/graphql",
        throwOnGraphQLErrors: true,
      });
      const r = await gh.query(UserQuery, { id: "9" });
      expect(r.ok && r.data.user?.name).toBe("user 9");
      expect(r.response.headers.get("content-type")).toBe(
        "application/graphql-response+json",
      );
    } finally {
      await served.stop(true);
    }
  });
});

describe("documents", () => {
  /** An AST document as a parser makes it, with or without its source. */
  const ast = (
    source: string | undefined,
    operation: "query" | "mutation",
    name: string,
  ) => ({
    kind: "Document",
    definitions: [
      { kind: "FragmentDefinition", name: { value: "Fields" } },
      { kind: "OperationDefinition", operation, name: { value: name } },
    ],
    ...(source === undefined
      ? {}
      : { loc: { start: 0, end: source.length, source: { body: source } } }),
  });

  it("sends a parsed document's loc.source.body", async () => {
    const server = endpoint();
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/g",
    });
    const document = ast(USER, "query", "User") as TypedDocumentNode<
      UserData,
      { id: string }
    >;
    const r = await gh.query(document, { id: "1" });
    expect(r.ok).toBe(true);
    expect(JSON.parse(server.seen[0].body).query).toBe(USER);
  });

  it("prints a document with no loc with the app's print, once per document; without print it throws", async () => {
    const server = endpoint();
    const printed: unknown[] = [];
    const print = (document: unknown) => {
      printed.push(document);
      return USER;
    };
    const document = ast(undefined, "query", "User") as TypedDocumentNode<
      UserData,
      { id: string }
    >;
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/g",
      print,
    });
    await gh.query(document, { id: "1" });
    await gh.query(document, { id: "2" });
    expect(printed).toEqual([document]);
    expect(JSON.parse(server.seen[1].body)).toMatchObject({
      query: USER,
      operationName: "User",
    });

    // A document's text is kept once found (by any client): a fresh one here.
    const unprinted = ast(undefined, "query", "User") as TypedDocumentNode<
      UserData,
      { id: string }
    >;
    const noPrint = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/g",
    });
    const error = await noPrint
      .query(unprinted, { id: "1" })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ClientError);
    expect((error as Error).message).toContain("print");
    expect(server.seen.length).toBe(2);
  });

  it("takes a String object (graphql-codegen's TypedDocumentString)", async () => {
    // The shape codegen's client preset emits with `documentMode: "string"`.
    class TypedDocumentString<R, V> extends String {
      declare readonly __apiType?: (variables: V) => R;
      constructor(private readonly value: string) {
        super(value);
      }

      override toString(): string {
        return this.value;
      }
    }
    const server = endpoint();
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/g",
    });
    const document = new TypedDocumentString<UserData, { id: string }>(USER);
    const r = await gh.query(document, { id: "4" });
    expect(r.ok && r.data?.user?.id).toBe("4");
    expect(JSON.parse(server.seen[0].body)).toMatchObject({
      query: USER,
      operationName: "User",
    });
  });

  it("reads a text's operation past fragments, comments and strings", async () => {
    const server = graphqlEndpoint({
      operations: {
        Deep: () => ({ body: { data: {} } }),
        "": () => ({ body: { data: {} } }),
        Change: () => ({ body: { data: {} } }),
      },
    });
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/g",
    });
    const texts = [
      `# query Wrong { a }\nfragment F on T @d(a: { b: "}{ query Nope" }) { a { b } }\nquery Deep($a: [In] = [{x: 1}]) { ...F }`,
      `"""a description, query Nope { }"""\nquery\n  # a comment\n  , Deep { a }`,
      `fragment F on subscription { a }\n{ ...F }`,
    ];
    for (const text of texts) await gh.query(text);
    await gh.mutate(`fragment G on T { a } mutation Change { a }`);
    expect(server.seen.map((seen) => seen.operationName)).toEqual([
      "Deep",
      "Deep",
      undefined,
      "Change",
    ]);
  });

  it("refuses an operation of the other kind, or a subscription, before sending anything", async () => {
    const server = endpoint();
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/graphql",
    });
    const asQuery = await gh.query(RENAME).catch((thrown: unknown) => thrown);
    expect(asQuery).toBeInstanceOf(ClientError);
    expect((asQuery as Error).message).toBe(
      "POST /graphql: query() was given a mutation (Rename)",
    );
    const asMutation = await gh
      .mutate(USER, { id: "1" })
      .catch((thrown: unknown) => thrown);
    expect((asMutation as Error).message).toBe(
      "POST /graphql: mutate() was given a query (User)",
    );
    const subscription = await gh
      .query("subscription OnUser { user { id } }")
      .catch((thrown: unknown) => thrown);
    expect(subscription).toBeInstanceOf(ClientError);
    expect(server.seen.length).toBe(0);
  });
});

describe("results and errors", () => {
  it("returns partial data with errors as ok, extensions included", async () => {
    const server = endpoint();
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/g",
    });
    const r = await gh.query(UserQuery, { id: "missing" });
    expect(r).toMatchObject({
      ok: true,
      status: 200,
      data: { user: null },
      errors: [{ message: "No user missing", path: ["user"] }],
      extensions: { cost: 1 },
    });
  });

  it("treats an empty errors list as none", async () => {
    const server = graphqlEndpoint({
      operations: {
        User: () => ({ body: { data: { user: null }, errors: [] } }),
      },
    });
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/g",
      throwOnGraphQLErrors: true,
    });
    const r = await gh.query(UserQuery, { id: "1" });
    expect(r.errors).toBeUndefined();
  });

  it("throws GraphQLResponseError under throwOnGraphQLErrors, at the client or the call, keeping the partial data", async () => {
    const server = endpoint();
    const api = createClient({ fetch: server.fetch });
    const strict = createGraphQLClient({
      client: api,
      url: "/graphql",
      throwOnGraphQLErrors: true,
    });
    const error = await strict
      .query(UserQuery, { id: "missing" })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GraphQLResponseError);
    expect(error).toBeInstanceOf(ClientError);
    const graphQLError = error as GraphQLResponseError<UserData>;
    expect(graphQLError.message).toBe("POST /graphql: No user missing");
    expect(graphQLError.key).toBe("POST /graphql");
    expect(graphQLError.status).toBe(200);
    expect(graphQLError.data).toEqual({ user: null });
    expect(graphQLError.errors).toEqual([
      { message: "No user missing", path: ["user"] },
    ]);
    expect(graphQLError.extensions).toEqual({ cost: 1 });
    expect(graphQLError.response.status).toBe(200);

    // The call turns it off, or on.
    const lenient = await strict.query(
      UserQuery,
      { id: "missing" },
      { throwOnGraphQLErrors: false },
    );
    expect(lenient.errors?.length).toBe(1);
    const plain = createGraphQLClient({ client: api, url: "/graphql" });
    await expect(
      plain.query(UserQuery, { id: "missing" }, { throwOnGraphQLErrors: true }),
    ).rejects.toBeInstanceOf(GraphQLResponseError);
  });

  it("names how many more errors there were", async () => {
    const server = graphqlEndpoint({
      operations: {
        User: () => ({
          body: {
            data: null,
            errors: [{ message: "a" }, { message: "b" }, { message: "c" }],
          },
        }),
      },
    });
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/g",
      throwOnGraphQLErrors: true,
    });
    const error = await gh
      .query(UserQuery, { id: "1" })
      .catch((thrown: unknown) => thrown);
    expect((error as Error).message).toBe("POST /g: a (and 2 more)");
  });

  it("returns a request error's status as a failed result, its errors read; HttpError under the client's or the call's throwOnError", async () => {
    const server = graphqlEndpoint({ operations: {} });
    const lenient = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/graphql",
    });
    const r = await lenient.query(UserQuery, { id: "1" });
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      error: { errors: [{ message: 'Unknown operation "User".' }] },
      errors: [{ message: 'Unknown operation "User".' }],
    });
    const thrown = await lenient
      .query(UserQuery, { id: "1" }, { throwOnError: true })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(400);

    const strict = createGraphQLClient({
      client: createClient<Record<string, never>, { throwOnError: true }>({
        fetch: server.fetch,
        throwOnError: true,
      }),
      url: "/graphql",
    });
    await expect(strict.query(UserQuery, { id: "1" })).rejects.toBeInstanceOf(
      HttpError,
    );
    const back = await strict.query(
      UserQuery,
      { id: "1" },
      { throwOnError: false },
    );
    expect(back.ok).toBe(false);
  });

  it("returns a legacy application/json server's 200 request error as ok with errors and no data", async () => {
    const server = graphqlEndpoint({ operations: {}, legacy: true });
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/g",
    });
    const r = await gh.query(UserQuery, { id: "1" });
    expect(r).toMatchObject({
      ok: true,
      status: 200,
      errors: [{ message: 'Unknown operation "User".' }],
    });
    expect(r.data).toBeUndefined();
  });

  it("throws a ClientError for a 2xx body that is not a GraphQL response, and keeps a failed status's text", async () => {
    const gh = createGraphQLClient({
      client: createClient({
        fetch: async (request) =>
          new URL(request.url).pathname === "/html"
            ? new Response("<html>", {
                headers: { "content-type": "text/html" },
              })
            : new Response("bad gateway", {
                status: 502,
                headers: { "content-type": "text/plain" },
              }),
        retry: false,
      }),
      url: "/html",
    });
    const error = await gh
      .query(UserQuery, { id: "1" })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ClientError);
    expect((error as Error).message).toBe(
      "POST /html answered 200 with a body that is not a GraphQL response",
    );
    const proxy = createGraphQLClient({
      client: createClient({
        fetch: async () =>
          new Response("bad gateway", {
            status: 502,
            headers: { "content-type": "text/plain" },
          }),
        retry: false,
      }),
      url: "/x",
    });
    const r = await proxy.query(UserQuery, { id: "1" });
    expect(r).toMatchObject({ ok: false, status: 502, error: "bad gateway" });
    expect(r.ok === false && r.errors).toBeUndefined();
  });
});

describe("the client's request path", () => {
  it("applies the client's headers, the route's (by key), the call's, and the client's accept when it sets one", async () => {
    const server = endpoint();
    const api = createClient({
      fetch: server.fetch,
      headers: { "x-app": "1", accept: "application/json" },
      routes: { "POST /graphql": { headers: { "x-route": "2" } } },
    });
    const gh = createGraphQLClient({ client: api, url: "/graphql" });
    await gh.query(UserQuery, { id: "1" }, { headers: { "x-call": "3" } });
    const headers = server.seen[0].headers;
    expect([
      headers.get("x-app"),
      headers.get("x-route"),
      headers.get("x-call"),
    ]).toEqual(["1", "2", "3"]);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("runs the client's middleware and the call's, with the route key", async () => {
    const server = endpoint();
    const keys: string[] = [];
    const api = createClient({
      fetch: server.fetch,
      middleware: [
        async (ctx, next) => {
          keys.push(`client ${ctx.key}`);
          return next();
        },
      ],
    });
    const gh = createGraphQLClient({ client: api, url: "/graphql" });
    await gh.mutate(
      Rename,
      { id: "1", name: "Ada" },
      {
        middleware: [
          async (ctx, next) => {
            keys.push(`call ${ctx.key}`);
            return next();
          },
        ],
      },
    );
    expect(keys).toEqual(["client POST /graphql", "call POST /graphql"]);
  });

  it("sends the token and refreshes it once on a 401", async () => {
    let token = "old";
    const server = endpoint({
      User: (request) =>
        request.headers.get("authorization") === "Bearer new"
          ? { body: { data: { user: { id: "1", name: "a" } } } }
          : { status: 401, body: { errors: [{ message: "unauthorised" }] } },
    });
    let refreshes = 0;
    const api = createClient({
      fetch: server.fetch,
      auth: {
        token: () => token,
        refresh: async () => {
          refreshes++;
          token = "new";
          return token;
        },
      },
    });
    const gh = createGraphQLClient({ client: api, url: "/graphql" });
    const r = await gh.query(UserQuery, { id: "1" });
    expect(r.ok).toBe(true);
    expect(refreshes).toBe(1);
    expect(
      server.seen.map((seen) => seen.headers.get("authorization")),
    ).toEqual(["Bearer old", "Bearer new"]);
  });

  it("retries a query (a POST) as an idempotent request, and never a mutation", async () => {
    const flaky =
      (data: unknown) =>
      (_request: SeenRequest, attempt: number): Answer =>
        attempt === 1
          ? { status: 503, body: { errors: [{ message: "busy" }] } }
          : { body: { data } };
    const server = endpoint({
      User: flaky({ user: { id: "1", name: "a" } }),
      Rename: flaky({ rename: { id: "1", name: "b" } }),
    });
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch, retry: FAST }),
      url: "/graphql",
    });
    const query = await gh.query(UserQuery, { id: "1" });
    expect(query.status).toBe(200);
    const mutation = await gh.mutate(Rename, { id: "1", name: "b" });
    expect(mutation.status).toBe(503);
    expect(server.seen.map((seen) => seen.operationName)).toEqual([
      "User",
      "User",
      "Rename",
    ]);
  });

  it("keeps the client's, the route's or the call's retry: false for a query; a later level's object turns them back on", async () => {
    const busy = (): Answer => ({
      status: 503,
      body: { errors: [{ message: "busy" }] },
    });
    const off = endpoint({ User: busy });
    await createGraphQLClient({
      client: createClient({ fetch: off.fetch, retry: false }),
      url: "/graphql",
    }).query(UserQuery, { id: "1" });
    expect(off.seen.length).toBe(1);

    const route = endpoint({ User: busy });
    await createGraphQLClient({
      client: createClient({
        fetch: route.fetch,
        retry: FAST,
        routes: { "POST /graphql": { retry: false } },
      }),
      url: "/graphql",
    }).query(UserQuery, { id: "1" });
    expect(route.seen.length).toBe(1);

    const call = endpoint({ User: busy });
    await createGraphQLClient({
      client: createClient({ fetch: call.fetch, retry: FAST }),
      url: "/graphql",
    }).query(UserQuery, { id: "1" }, { retry: false });
    expect(call.seen.length).toBe(1);

    const back = endpoint({ User: busy });
    await createGraphQLClient({
      client: createClient({ fetch: back.fetch, retry: false }),
      url: "/graphql",
    }).query(UserQuery, { id: "1" }, { retry: { ...FAST, attempts: 1 } });
    expect(back.seen.length).toBe(2);
  });

  it("times out, and aborts with the caller's reason", async () => {
    const hang = async (request: Request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () =>
          reject(request.signal.reason as Error),
        );
      });
    const gh = createGraphQLClient({
      client: createClient({ fetch: hang }),
      url: "/g",
    });
    await expect(
      gh.query(UserQuery, { id: "1" }, { timeout: 20 }),
    ).rejects.toBeInstanceOf(TimeoutError);
    const controller = new AbortController();
    const pending = gh.query(
      UserQuery,
      { id: "1" },
      { signal: controller.signal },
    );
    const reason = new Error("stop");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

describe("BYO result validation (validate.result)", () => {
  /** A hand-written Standard Schema: a user whose name is a non-empty string, upper-cased. */
  const Shouting: StandardSchemaV1<
    unknown,
    { user: { id: string; name: string } }
  > = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        const name = (value as UserData).user?.name;
        return typeof name === "string" && name.length > 0
          ? {
              value: {
                user: {
                  id: (value as UserData).user!.id,
                  name: name.toUpperCase(),
                },
              },
            }
          : { issues: [{ message: "a name", path: ["user", "name"] }] };
      },
    },
  };

  it("delivers the schema's output as data when it passes", async () => {
    const server = endpoint();
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch, mode: "production" }),
      url: "/g",
    });
    const r = await gh.query(
      UserQuery,
      { id: "1" },
      { validate: { result: Shouting } },
    );
    expect(r.ok && r.data).toEqual({ user: { id: "1", name: "USER 1" } });
  });

  it('warns through the client\'s logger and delivers the data as it arrived when it fails; throws a ValidationError under onFailure: "throw"', async () => {
    const server = graphqlEndpoint({
      operations: {
        User: () => ({ body: { data: { user: { id: "1", name: "" } } } }),
      },
    });
    const warnings: unknown[][] = [];
    const logger = {
      warn: (...args: unknown[]) => warnings.push(args),
      error: () => {},
      debug: () => {},
    };
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch, logger }),
      url: "/g",
    });
    const r = await gh.query(
      UserQuery,
      { id: "1" },
      { validate: { result: Shouting } },
    );
    expect(r.ok && r.data).toEqual({ user: { id: "1", name: "" } });
    expect(warnings.length).toBe(1);

    const error = await gh
      .query(
        UserQuery,
        { id: "1" },
        { validate: { result: Shouting, onFailure: "throw" } },
      )
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues).toEqual([
      {
        target: "response",
        message: "a name",
        path: "data.user.name",
        key: "200",
        source: "custom",
      },
    ]);
  });

  it("does not run on a response without data, nor on a failed status", async () => {
    const calls: unknown[] = [];
    const Spy: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => {
          calls.push(value);
          return { value };
        },
      },
    };
    const server = graphqlEndpoint({
      operations: {
        User: (request) =>
          (request.variables as { id: string }).id === "null"
            ? { body: { data: null, errors: [{ message: "x" }] } }
            : { status: 400, body: { errors: [{ message: "y" }] } },
      },
    });
    const gh = createGraphQLClient({
      client: createClient({ fetch: server.fetch }),
      url: "/g",
    });
    await gh.query(
      UserQuery,
      { id: "null" },
      { validate: { result: Spy, onFailure: "throw" } },
    );
    await gh.query(
      UserQuery,
      { id: "400" },
      { validate: { result: Spy, onFailure: "throw" } },
    );
    expect(calls).toEqual([]);
  });
});
