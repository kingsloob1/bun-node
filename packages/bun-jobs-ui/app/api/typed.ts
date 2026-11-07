import type { Client, ClientMiddleware } from "@kingsleyweb/bun-client";
import type { Queries } from "@kingsleyweb/bun-client/query";
import type { ApiClient } from "./client";
import type { Routes } from "./routes.gen";
import {
  createClient,
  NetworkError,
  UnexpectedStatusError,
} from "@kingsleyweb/bun-client";
import { queries } from "@kingsleyweb/bun-client/query";
import { errorFromResponse } from "./client";
import { ApiError, isProblem } from "./errors";
import { manifest } from "./routes.gen";

/**
 * The typed client (`@kingsleyweb/bun-client`, typed-client plan §11): the
 * management API's routes as `routes.gen.ts` types them, generated from the
 * API's own OpenAPI document (`bun run gen:client`; CI runs
 * `bun run check:client`). A domain moved onto it calls routes by their path
 * literal, with typed params, query and body, and reads a result whose
 * error `code` is the route's own union; its query keys come from
 * `./query`.
 *
 * It sends through the app's {@link ApiClient}: the same `fetch` (so a
 * test's mock sees every request), the same headers (`Accept`, the JSON
 * `Content-Type` on every POST/PUT/PATCH, the CSRF header on mutations) and
 * credentials. Retries and timeouts are TanStack Query's and the browser's,
 * as for the rest of the app, so the client adds none of its own. Its
 * failures reach the screens as the app's {@link ApiError}
 * ({@link toApiError}), which the error views, the retry policy and
 * `isApiError` read.
 *
 * The pilot moved the summon domain (`api/summon.ts`); the others still use
 * `ApiClient.request`.
 */

/** The typed client and its query factories, over one {@link ApiClient}. */
export interface TypedApi {
  /** The client: `client.get("/summon")`, `client.post("/queues/:queue/summon", …)`. */
  client: Client<Routes>;
  /** The query factories over it: `q.key("GET /summon")`. */
  q: Queries<Routes>;
}

/** One {@link TypedApi} per app client, built on first use. */
const built = new WeakMap<ApiClient, TypedApi>();

/** The {@link TypedApi} sending through `api`. */
export function typedApi(api: ApiClient): TypedApi {
  let typed = built.get(api);
  if (typed === undefined) {
    const client = createClient<Routes>({
      baseUrl: api.base,
      manifest,
      fetch: (request) => send(api, request),
      headers: (ctx) => api.headers(ctx.method),
      middleware: [jsonOnly(api)],
      retry: false,
      timeout: false,
    });
    typed = { client, q: queries(client, { manifest }) };
    built.set(api, typed);
  }
  return typed;
}

/** Sends the client's `Request` through the app's `fetch`, in the `(url, init)` form it takes. */
async function send(api: ApiClient, request: Request): Promise<Response> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const init: RequestInit = {
    method: request.method,
    headers,
    credentials: request.credentials,
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = await request.text();
    if (body !== "") {
      init.body = body;
    }
  }
  return api.fetch(request.url, init);
}

/** Whether a `Content-Type` names JSON (`application/json` or any `+json`). */
function isJsonType(contentType: string): boolean {
  const media = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return media === "application/json" || media.endsWith("+json");
}

/**
 * Refuses a 2xx with a body that is not JSON, as `ApiClient.request` does
 * (`parse`, `INVALID_RESPONSE`): a misrouted proxy's HTML page, say. The
 * typed client would otherwise hand the text to a screen typed for JSON.
 */
function jsonOnly(api: ApiClient): ClientMiddleware {
  return async (ctx, next) => {
    const response = await next();
    if (
      !response.ok ||
      response.status === 204 ||
      isJsonType(response.headers.get("content-type") ?? "")
    ) {
      return response;
    }
    const text = await response.clone().text();
    if (text === "") {
      return response;
    }
    throw new ApiError({
      kind: "parse",
      status: response.status,
      code: "INVALID_RESPONSE",
      title: "The API answered something other than JSON",
      detail: text.trim().slice(0, 300) || undefined,
      instance: instanceOf(api, ctx.request.url),
    });
  };
}

/** The path a request was for, under the API base, as an {@link ApiError}'s `instance`. */
export function instanceOf(api: ApiClient, url: string): string {
  const { pathname } = new URL(url, "http://localhost");
  return pathname.startsWith(api.base)
    ? pathname.slice(api.base.length)
    : pathname;
}

/** A failed answer the typed client resolved: a declared error status. */
interface Failed {
  /** Always `false`. */
  ok: false;
  /** The status. */
  status: number;
  /** The parsed body. */
  error: unknown;
  /** The response, its body read. */
  response: Response;
}

/**
 * The app's {@link ApiError} for a declared error status the typed client
 * resolved: the problem's fields when the body is a problem, else an `http`
 * error for the status.
 */
export function failedError(failed: Failed, instance: string): ApiError {
  if (isProblem(failed.error)) {
    // As `ApiClient.request` builds one: the problem's fields, verbatim.
    return ApiError.fromProblem({ ...failed.error, status: failed.status });
  }
  return new ApiError({
    kind: "http",
    status: failed.status,
    code: `HTTP_${failed.status}`,
    title: failed.response.statusText || `Request failed (${failed.status})`,
    ...(typeof failed.error === "string" && failed.error.trim() !== ""
      ? { detail: failed.error.trim().slice(0, 300) }
      : {}),
    instance,
  });
}

/**
 * Turns what the typed client threw into what the rest of the app throws:
 * an undeclared status (its body still unread) as the {@link ApiError}
 * `ApiClient.request` would have built from it, and a failed `fetch` as a
 * `network` one. Anything else (an abort above all, or the app's own
 * {@link ApiError} from {@link jsonOnly}) is returned as it is.
 */
export async function toApiError(
  error: unknown,
  instance: string,
): Promise<unknown> {
  if (error instanceof UnexpectedStatusError) {
    const text = await error.response.text().catch(() => "");
    return errorFromResponse(error.response, text, instance);
  }
  if (error instanceof NetworkError) {
    const cause = error.cause;
    return new ApiError({
      kind: "network",
      status: 0,
      code: "NETWORK_ERROR",
      title: "The API could not be reached",
      detail: cause instanceof Error ? cause.message : String(cause),
      instance,
      cause,
    });
  }
  return error;
}

/** A typed call's success, or a thrown {@link ApiError}: what a query function resolves. */
export async function dataOf<T extends { ok: true; data: unknown } | Failed>(
  call: Promise<T>,
  instance: string,
): Promise<Extract<T, { ok: true }>["data"]> {
  let result: T;
  try {
    result = await call;
  } catch (error) {
    throw await toApiError(error, instance);
  }
  if (result.ok) {
    return result.data;
  }
  throw failedError(result, instance);
}
