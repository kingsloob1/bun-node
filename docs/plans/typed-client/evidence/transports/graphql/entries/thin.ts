/** A typed GraphQL-over-HTTP call as the plan's `graphql()` would be: a document (string, or a TypedDocumentNode's printed body), variables, the result typed by the document. No GraphQL library. */
export interface TypedDocument<R, V> { readonly __apiType?: (v: V) => R; readonly source: string }
export interface GraphQLResult<R> { data?: R; errors?: { message: string; path?: (string | number)[] }[] }
export async function graphql<R, V>(url: string, doc: TypedDocument<R, V>, variables: V, init?: RequestInit): Promise<GraphQLResult<R>> {
  const res = await fetch(url, { ...init, method: "POST", headers: { "content-type": "application/json", accept: "application/graphql-response+json, application/json" }, body: JSON.stringify({ query: doc.source, variables }) });
  if (!res.ok && res.headers.get("content-type")?.includes("json") !== true) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as GraphQLResult<R>;
}
