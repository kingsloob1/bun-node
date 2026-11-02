# Typed client: GraphQL

A sub-plan of [`README.md`](README.md) (**TC**). The user asked for typing
and validation for "graphql if any". This document answers whether bun-node
serves GraphQL, lays out the options, and recommends one.

Written 2026-11-02 against `develop` at `e80ab379`. **No product code was
changed.** Markings as in TC. Evidence:
[`evidence/transports/graphql/`](evidence/transports/README.md).

**Status (2026-11-02): approved by the user** (TC §14, Q25; names as in
TC §16). **Nothing is built.** The next PRs are TC's **PR-K**,
**PR-M1** and **PR-C1**; this sub-plan's PRs follow them as TC §15 orders.

---

## 1. Does bun-node serve GraphQL?

**No** [S]. `grep -rliE "graphql" --exclude-dir=node_modules packages
examples playground` finds nothing; the only GraphQL in the repository is
`@octokit/graphql`, a transitive dependency in `bun.lock`. No package
depends on `graphql`, and no plan proposes a GraphQL server.

So "typing GraphQL" can only mean a client for **someone else's** GraphQL
API, unless bun-node grows a GraphQL server.

## 2. The options

| | Option | What it is | Cost |
|---|---|---|---|
| **(a1)** | Our own codegen | read an SDL or an introspection result, generate TypeScript types per operation (and maybe Zod for results), as graphql-codegen's `typescript-operations` does | a GraphQL parser and a type generator of our own: the type rules for fragments, aliases, `@include`/`@skip`, unions, interfaces and custom scalars are the bulk of graphql-codegen [I]; weeks, and a second schema language to keep current |
| **(a2)** | **A typed GraphQL call on the HTTP core, typed by the app's own tooling** | `api.graphql(document, variables)` accepts any `TypedDocumentNode<Result, Variables>` (the shared standard both gql.tada and graphql-codegen's client preset emit) or a typed string document, and sends it as a GraphQL-over-HTTP POST through the client core: auth, retries, middleware, timeouts, errors, the query layer's caching | ~0.3 KB gz of ours [M]; the types come from gql.tada (inference, no per-operation codegen) or graphql-codegen, which the app chooses and installs |
| **(a3)** | Depend on a GraphQL client (urql, Apollo) | wrap one | 10.5 KB gz for `@urql/core` [M]; a second cache beside query-core |
| **(b)** | bun-node serves GraphQL | a GraphQL server on bun-common (schema, resolvers, validation, subscriptions) | a new product, with `graphql` as a runtime dependency; nothing asks for it |
| **(c)** | None | — | — |

### 2.1 Measured [M]

Browser bundles, minified, gzip (`graphql/size.ts`, `size-results.txt`; Bun
1.4.4-canary.1+11c367163):

| Runtime | min | gzip |
|---|---|---|
| **(a2) the thin typed POST** (`entries/thin.ts`, what `api.graphql()` adds) | 0.4 KB | **0.3 KB** |
| gql.tada's `graphql()` + `@0no-co/graphql.web` `print` (when the app uses gql.tada documents) | 10.3 KB | 3.4 KB |
| `graphql` 17.0.2 `parse` + `print` | 42.8 KB | 11.4 KB |
| `@urql/core` 6.0.3 client | 30.5 KB | 10.5 KB |

What typing an API with gql.tada costs a client's type check
(`graphql/tada.ts`: an SDL of T object types with 8 fields each and
relations, introspected with graphql-js, written as `graphql-env.d.ts` by
`@gql.tada/internal`; 50 operations with nested selections and variables,
each read through `ResultOf`/`VariablesOf`, with `@ts-expect-error`
negative controls on a field's type and a required variable; tsc 6.0.3 and
`bun --check`, median of 3, through the heavy-run wrapper):

| Object types | SDL | `graphql-env.d.ts` | tsc 6.0.3 check | memory | instantiations | `bun --check` |
|---|---|---|---|---|---|---|
| 50 | 9.5 KB | 77.2 KB | 2.48 s | 524 MB | 1.14 M | 345 ms |
| 200 | 38.9 KB | 288.3 KB | 2.19 s | 504 MB | 1.14 M | 359 ms |

The cost follows the **operations**, not the schema's size (the
instantiation count is the same at 50 and 200 types; the two tsc figures are
within run-to-run noise): about 2.2–2.5 s of tsc, or a third of a second of
`bun --check`, for 50 typed operations. Negative control: flipping a field's
expected type makes its `@ts-expect-error` unused, and `bun --check` fails
with TS2578 [M, `tada-results.txt`]. So the app's own tool gives typed
GraphQL at a cost comparable to a typed HTTP client of similar size (§3.1 of
TC), with nothing of ours involved.

## 3. Recommendation [D]

**(a2), built last and on demand; not (a1), (a3) or (b).**

- **Why not (b):** nothing in bun-node or its users' requests serves
  GraphQL; a server is a product of its own with a runtime dependency on
  `graphql` (11.4 KB gz in a browser, 10 MB installed [M]), against the
  dependency policy (CLAUDE.md) for no stated need.
- **Why not (a1):** gql.tada already infers every operation's types from the
  introspection with no per-operation step, and graphql-codegen covers the
  codegen style; ours would be a slower copy of either.
- **Why not (a3):** a second normalised cache beside query-core (TC D12),
  and 10.5 KB gz.
- **Why (a2):** a GraphQL query is one POST. Sending it through the client
  core gives a GraphQL call everything an HTTP call has (auth refresh,
  retries for queries, middleware, timeouts, typed errors, query-core keys
  and caching through `/query`) for 0.3 KB, with the types from whichever of
  the two standard tools the app already uses, and no dependency of ours.

### 3.1 The (a2) design [D]

```ts
import { graphql } from "./graphql";                      // the app's gql.tada setup
const UserQuery = graphql(`query User($id: ID!) { user(id: $id) { id name } }`);

const gh = createGraphQLClient({ url: "https://api.example.com/graphql", client: api });
const r = await gh.query(UserQuery, { id: "1" });          // { data: ResultOf<…> | undefined, errors?: GraphQLError[] }
q.graphql(gh, UserQuery, { id });                          // query-core options: key [url, operationName, variables]
```

- **Typing**: `TypedDocumentNode<R, V>` (structural: the `__apiType`
  phantom both tools emit) or `TypedString<R, V>`; no import of `graphql` or
  `@graphql-typed-document-node/core`. A `DocumentNode` is printed with the
  app's own `print` passed in, or sent as `loc.source.body` when present [I:
  gql.tada documents carry their source; verified per tool in the PR].
- **Transport**: GraphQL over HTTP (`application/graphql-response+json`,
  POST; GET for queries opt-in, for CDN caching). Mutations are never
  retried; queries are, as idempotent requests.
- **Errors**: the GraphQL-over-HTTP spec's statuses become TC's `Result`;
  a 200 with `errors` is `{ ok: true, data, errors }` (partial data is
  legitimate in GraphQL), and `throwOnGraphQLErrors: true` turns it into a
  `GraphQLResponseError` [D].
- **Validation**: the server validates against its schema; the client's
  built-in check is **none** (there is no generated runtime schema for
  GraphQL, by choice). BYO: a Standard Schema per document for the result
  (`validate: { result: Schema }`), under TC §5.5's policy, for an app that
  wants to guard a third-party API's drift [D].
- **Subscriptions** (graphql-ws, GraphQL over SSE) are out of scope.

## 4. PR and effort

| PR | What | Depends on | Effort |
|---|---|---|---|
| **PR-G1** (on demand) | `createGraphQLClient`, `query`/`mutate`, `TypedDocumentNode` and typed-string support, errors, BYO result validation, `q.graphql()` | TC PR-C1, PR-C5 | ~2 d |

Questions: answered 2026-11-02 (TC §14 Q25, approved as recommended). Names: TC §16, approved 2026-11-02.
