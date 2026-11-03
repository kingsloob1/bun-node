/**
 * `./graphql`'s types (`graphql.md` §3.1): the result and variables come
 * from a typed document (a `TypedDocumentNode`, a `TypedString`, a
 * `String` object with the phantom), a plain string is untyped; variables
 * are required when the operation has a required one; `errors` absent
 * narrows `data` to the complete result; `throwOnGraphQLErrors` (client or
 * call) leaves no result with errors and `throwOnError` (the HTTP client's
 * or the call's) no failed one; a BYO result schema types `data`; and
 * `q.graphql()` tags its key with the data. Checked by `bun run check`
 * (`bun test --check` reads no `*.type-test.ts`). Each `@ts-expect-error`
 * is a negative control: remove the refusal it covers and the check fails
 * on the unused directive.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-contract";
import type {
  GraphQLResult,
  ResultOf,
  TypedDocumentNode,
  TypedString,
  VariablesOf,
} from "../lib/graphql";
import { QueryClient } from "@tanstack/query-core";
import { createGraphQLClient } from "../lib/graphql";
import { createClient } from "../lib/index";
import { queries } from "../lib/query";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

interface UserData {
  user: { id: string; name: string } | null;
}
declare const UserNode: TypedDocumentNode<UserData, { id: string }>;
const UserText =
  "query User($id: ID!) { user(id: $id) { id name } }" as TypedString<
    UserData,
    { id: string }
  >;
declare const MeNode: TypedDocumentNode<
  { me: string },
  // graphql-codegen's variables for an operation without any.
  { [key: string]: never }
>;
declare const Optional: TypedDocumentNode<{ n: number }, { limit?: number }>;
/** graphql-codegen's `TypedDocumentString` (a `String` object with the phantom). */
declare class TypedDocumentString<R, V> extends String {
  readonly __apiType?: (variables: V) => R;
}
declare const UserString: TypedDocumentString<UserData, { id: string }>;

export type _result = Expect<Equal<ResultOf<typeof UserNode>, UserData>>;
export type _variables = Expect<
  Equal<VariablesOf<typeof UserText>, { id: string }>
>;
export type _untyped = Expect<Equal<ResultOf<"{ me }">, unknown>>;
export type _untypedVariables = Expect<
  Equal<VariablesOf<"{ me }">, Readonly<Record<string, unknown>>>
>;

const api = createClient();
const gh = createGraphQLClient({ client: api, url: "/graphql" });

async function probe() {
  const r = await gh.query(UserNode, { id: "1" });
  if (r.ok) {
    if (!r.errors) {
      const _complete: Equal<typeof r.data, UserData> = true;
      void _complete;
    } else {
      const _partial: Equal<typeof r.data, UserData | null | undefined> = true;
      void _partial;
    }
  } else {
    const _status: Equal<typeof r.status, number> = true;
    const _error: Equal<typeof r.error, unknown> = true;
    void _status;
    void _error;
  }
  const fromText = await gh.query(UserText, { id: "1" });
  const _text: Equal<typeof fromText, GraphQLResult<UserData>> = true;
  const fromString = await gh.query(UserString, { id: "1" });
  const _string: Equal<typeof fromString, GraphQLResult<UserData>> = true;
  const untyped = await gh.query("{ me }");
  const _any: Equal<typeof untyped, GraphQLResult<unknown>> = true;
  void [fromText, fromString, untyped, _text, _string, _any];

  // Variables: required when one is required, optional otherwise.
  await gh.query(MeNode);
  await gh.query(Optional);
  await gh.query(Optional, { limit: 1 });
  // @ts-expect-error -- `id` is required
  await gh.query(UserNode);
  // @ts-expect-error -- `id` is a string
  await gh.query(UserNode, { id: 1 });
  // @ts-expect-error -- no such variable
  await gh.query(UserNode, { id: "1", extra: true });
  await gh.mutate(UserNode, { id: "1" }, { timeout: 5 });

  // throwOnGraphQLErrors: no result with errors.
  const strict = createGraphQLClient({
    client: api,
    url: "/graphql",
    throwOnGraphQLErrors: true,
  });
  const s = await strict.query(UserNode, { id: "1" });
  if (s.ok) {
    const _data: Equal<typeof s.data, UserData> = true;
    const _errors: Equal<typeof s.errors, undefined> = true;
    void [_data, _errors];
  }
  const back = await strict.query(
    UserNode,
    { id: "1" },
    { throwOnGraphQLErrors: false },
  );
  const _back: Equal<typeof back, GraphQLResult<UserData>> = true;
  const onCall = await gh.query(
    UserNode,
    { id: "1" },
    { throwOnGraphQLErrors: true },
  );
  const _onCall: Equal<typeof onCall, GraphQLResult<UserData, true>> = true;
  void [back, onCall, _back, _onCall];

  // throwOnError (the HTTP client's flag, or the call's): no failed result.
  const throwing = createGraphQLClient({
    client: createClient<Record<string, never>, { throwOnError: true }>({
      throwOnError: true,
    }),
    url: "/graphql",
  });
  const t = await throwing.query(UserNode, { id: "1" });
  const _ok: Equal<typeof t.ok, true> = true;
  const lenient = await throwing.query(
    UserNode,
    { id: "1" },
    { throwOnError: false },
  );
  const _lenient: Equal<typeof lenient, GraphQLResult<UserData>> = true;
  const both = await strict.query(
    UserNode,
    { id: "1" },
    { throwOnError: true },
  );
  const _both: Equal<typeof both, GraphQLResult<UserData, true, true>> = true;
  void [t, lenient, _ok, _lenient, _both];
  if (both.ok) both.data.user?.name.toUpperCase();
  const loose = await gh.query(UserNode, { id: "1" });
  // @ts-expect-error -- without throwOnGraphQLErrors, data may be partial: null or absent
  if (loose.ok) void loose.data.user;

  // A BYO result schema types data as its output.
  const Dated = {} as StandardSchemaV1<unknown, { at: Date }>;
  const v = await strict.query(
    UserNode,
    { id: "1" },
    { validate: { result: Dated } },
  );
  if (v.ok) {
    const _dated: Equal<typeof v.data, { at: Date }> = true;
    void _dated;
  }
  // @ts-expect-error -- `validate.result` is a Standard Schema
  await gh.query(UserNode, { id: "1" }, { validate: { result: 1 } });
  // @ts-expect-error -- a method is "GET" or "POST"
  await gh.query(UserNode, { id: "1" }, { method: "PUT" });
}
void probe;

// The query layer: the key tagged with the data, variables as the call's.
const q = queries(api);
const options = q.graphql(gh, UserNode, { id: "1" }, { tags: ["user:1"] });
const queryClient = new QueryClient();
const cached = queryClient.getQueryData(options.queryKey);
export type _cached = Expect<Equal<typeof cached, UserData | undefined>>;
void cached;
q.graphql(gh, MeNode);
// @ts-expect-error -- `id` is required
q.graphql(gh, UserNode);
// @ts-expect-error -- `signal` is query-core's
q.graphql(gh, UserNode, { id: "1" }, { signal: new AbortController().signal });
const validated = q.graphql(
  gh,
  UserNode,
  { id: "1" },
  {
    validate: { result: {} as StandardSchemaV1<unknown, { n: 1 }> },
  },
);
export type _validated = Expect<
  Equal<ReturnType<typeof validated.queryFn>, Promise<{ n: 1 }>>
>;
void validated;
