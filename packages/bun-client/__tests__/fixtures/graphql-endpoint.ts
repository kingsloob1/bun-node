/**
 * A small GraphQL-over-HTTP endpoint for the `./graphql` tests, written by
 * hand (no GraphQL library; `graphql.md` §1: bun-node serves none). It
 * reads a request as the spec says (a `POST` of JSON `{ query, variables,
 * operationName, extensions }`, or a `GET` with those as URL parameters,
 * `variables` and `extensions` JSON-encoded), dispatches on the operation
 * name to a scripted answer, and records every request it saw.
 *
 * Its answers follow the spec's `application/graphql-response+json` rules:
 * a request it cannot read is a `400` with `errors` and no `data`; an
 * executed operation is a `200` with `data` (and `errors` for a field
 * error). `legacy` answers as an `application/json` server does: `200`
 * whatever happened.
 */

/** One request as the endpoint read it. */
export interface SeenRequest {
  /** The method. */
  readonly method: string;
  /** The URL, as received. */
  readonly url: string;
  /** The request's headers. */
  readonly headers: Headers;
  /** The `query` parameter. */
  readonly query: string | undefined;
  /** The `variables`, decoded. */
  readonly variables: unknown;
  /** The `operationName`. */
  readonly operationName: string | undefined;
  /** The raw body text (`""` for a `GET`). */
  readonly body: string;
}

/** A scripted answer: a status and a JSON body (the endpoint's media type), or a whole `Response`. */
export type Answer =
  | {
      /** The status. Default: `200`. */
      readonly status?: number;
      /** The body, written as JSON. */
      readonly body: unknown;
      /** Extra headers. */
      readonly headers?: Record<string, string>;
    }
  | Response;

/** Answers one operation from what the request carried. */
export type Resolver = (request: SeenRequest, attempt: number) => Answer;

/** The endpoint's options. */
export interface EndpointOptions {
  /** Answers by operation name (`""` for an anonymous operation). */
  readonly operations: Readonly<Record<string, Resolver>>;
  /** Answer as a legacy `application/json` server: always 200. Default: `false`. */
  readonly legacy?: boolean;
}

/** The endpoint: a `fetch` handler and what it saw. */
export interface Endpoint {
  /** The handler, for `createClient({ fetch })` or `Bun.serve({ fetch })`. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** Every request, in order. */
  readonly seen: SeenRequest[];
}

/** Decodes a JSON parameter, or `undefined` when absent. */
function decoded(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value);
}

/** Creates the endpoint. */
export function graphqlEndpoint(options: EndpointOptions): Endpoint {
  const seen: SeenRequest[] = [];
  const attempts = new Map<string, number>();
  const type = options.legacy
    ? "application/json"
    : "application/graphql-response+json";
  const answer = (value: Answer): Response =>
    value instanceof Response
      ? value
      : new Response(JSON.stringify(value.body), {
          status: options.legacy ? 200 : (value.status ?? 200),
          headers: { "content-type": type, ...value.headers },
        });

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    let params: {
      query?: string;
      variables?: unknown;
      operationName?: string;
    };
    try {
      params =
        request.method === "GET"
          ? {
              query: url.searchParams.get("query") ?? undefined,
              variables: decoded(url.searchParams.get("variables")),
              operationName: url.searchParams.get("operationName") ?? undefined,
            }
          : (JSON.parse(text) as typeof params);
    } catch {
      return answer({
        status: 400,
        body: { errors: [{ message: "bad JSON" }] },
      });
    }
    const seenRequest: SeenRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      query: params.query,
      variables: params.variables,
      operationName: params.operationName,
      body: text,
    };
    seen.push(seenRequest);
    if (typeof params.query !== "string")
      return answer({
        status: 400,
        body: { errors: [{ message: "Must provide query string." }] },
      });
    const name = params.operationName ?? "";
    const resolver = options.operations[name];
    if (resolver === undefined)
      return answer({
        status: 400,
        body: { errors: [{ message: `Unknown operation "${name}".` }] },
      });
    const attempt = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, attempt);
    return answer(resolver(seenRequest, attempt));
  };
  return { fetch, seen };
}
