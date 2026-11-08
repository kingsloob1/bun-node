import type { FetchLike } from "../../app/api/client";

/** One request the mock received. */
export interface RecordedCall {
  /** The method. */
  method: string;
  /** The full URL as the client built it. */
  url: string;
  /** The path under the API base, without the query. */
  path: string;
  /** The parsed query. */
  query: URLSearchParams;
  /** Headers, with lower-cased names. */
  headers: Record<string, string>;
  /** The raw body, or `undefined`. */
  body: string | undefined;
  /** The `credentials` mode. */
  credentials: RequestCredentials | undefined;
}

/** What a handler answers: a status and a JSON body (or a ready `Response`). */
export type MockReply =
  | Response
  | {
      /** HTTP status. Defaults to 200. */
      status?: number;
      /** JSON body; omitted for 204. */
      body?: unknown;
      /** Content type. Defaults to `application/json`, or `application/problem+json` at 4xx/5xx. */
      contentType?: string;
    };

/** A handler for one `"METHOD /path"` key. */
export type MockHandler = (
  call: RecordedCall,
) => MockReply | Promise<MockReply>;

/**
 * A fake `fetch` answering by `"GET /meta"`-style keys (path under `base`,
 * no query). Unknown routes answer the API's JSON 404. Every call is recorded.
 */
export function mockFetch(
  handlers: Record<string, MockHandler | MockReply>,
  base = "/jobs-api",
) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input, "http://localhost");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(
      (init.headers ?? {}) as Record<string, string>,
    )) {
      headers[name.toLowerCase()] = value;
    }
    const path = url.pathname.startsWith(base)
      ? url.pathname.slice(base.length)
      : url.pathname;
    const call: RecordedCall = {
      method: init.method ?? "GET",
      url: input,
      path,
      query: url.searchParams,
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
      credentials: init.credentials,
    };
    calls.push(call);
    if (init.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const handler = handlers[`${call.method} ${path}`];
    const reply: MockReply =
      handler === undefined
        ? {
            status: 404,
            body: {
              type: "urn:bun-jobs:error:ROUTE_NOT_FOUND",
              title: "Route not found",
              status: 404,
              code: "ROUTE_NOT_FOUND",
              detail: `No route for ${call.method} ${url.pathname}`,
            },
          }
        : typeof handler === "function"
          ? await handler(call)
          : handler;
    if (reply instanceof Response) {
      return reply;
    }
    const status = reply.status ?? 200;
    if (status === 204) {
      return new Response(null, { status });
    }
    return new Response(JSON.stringify(reply.body), {
      status,
      headers: {
        "content-type":
          reply.contentType ??
          (status >= 400 ? "application/problem+json" : "application/json"),
      },
    });
  };
  return { fetch, calls };
}
