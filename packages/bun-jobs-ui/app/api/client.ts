import type { UiConfig } from "../../shared/config.ts";
import type {
  MetaDto,
  Overview,
  PausedResult,
  Permissions,
  QueueList,
  QueueThroughput,
  WorkerList,
} from "./types";
import { JSON_METHODS, MUTATING_METHODS } from "./contract";
import { ApiError, isProblem } from "./errors";

/** An HTTP method the client sends. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A scalar query value. */
export type QueryScalar = string | number | boolean;

/**
 * A query-string value: arrays become repeated keys (`state=a&state=b`), an
 * empty array becomes `key=` (the API reads that as `[]`), and `undefined` /
 * `null` are left out.
 */
export type QueryValue =
  | QueryScalar
  | readonly QueryScalar[]
  | null
  | undefined;

/** The query of one request. */
export type QueryParams = Readonly<Record<string, QueryValue>>;

/** Options of one {@link ApiClient.request}. */
export interface RequestOptions {
  /** Query parameters; see {@link QueryValue}. */
  query?: QueryParams;
  /** A JSON body. `undefined` sends none (the `Content-Type` still goes on POST/PUT/PATCH). */
  body?: unknown;
  /** Aborts the request (TanStack Query passes one). An abort rejects with the fetch's own `AbortError`, never an {@link ApiError}. */
  signal?: AbortSignal;
}

/** The `fetch` the client calls; injectable for tests and non-browser hosts. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Options of {@link createApiClient}. */
export interface ApiClientOptions {
  /** The `fetch` to use. Defaults to `globalThis.fetch`, looked up per call so a test can replace it. */
  fetch?: FetchLike;
}

/** Query for `GET /meta/permissions`: ask about one queue or runner. */
export interface PermissionsTarget {
  /** A queue name, passed to queue-side actions. */
  queue?: string;
  /** A runner id, passed to runner actions. */
  runner?: string;
}

/** A typed client for the bun-jobs management API. */
export interface ApiClient {
  /** The API base URL requests are prefixed with. */
  readonly base: string;
  /** Sends one request; resolves the parsed JSON (or `undefined` for a 204), rejects with an {@link ApiError}. */
  request: <T>(
    method: HttpMethod,
    path: string,
    options?: RequestOptions,
  ) => Promise<T>;
  /** `GET /meta`. */
  getMeta: (signal?: AbortSignal) => Promise<MetaDto>;
  /** `GET /meta/permissions`. */
  getPermissions: (
    target?: PermissionsTarget,
    signal?: AbortSignal,
  ) => Promise<Permissions>;
  /** `GET /overview`; `minutes` is the throughput window (1..1440, API default 60). */
  getOverview: (minutes?: number, signal?: AbortSignal) => Promise<Overview>;
  /** `GET /queues`; `search` is a case-sensitive name substring. */
  listQueues: (search?: string, signal?: AbortSignal) => Promise<QueueList>;
  /** `GET /queues/:queue/throughput`. */
  getQueueThroughput: (
    queue: string,
    minutes?: number,
    signal?: AbortSignal,
  ) => Promise<QueueThroughput>;
  /** `GET /workers`. */
  listWorkers: (signal?: AbortSignal) => Promise<WorkerList>;
  /** `POST /queues/:queue/pause` (bodiless). */
  pauseQueue: (queue: string) => Promise<PausedResult>;
  /** `POST /queues/:queue/resume` (bodiless). */
  resumeQueue: (queue: string) => Promise<PausedResult>;
}

/** The value sent in the CSRF header. The API accepts any non-empty value (contract §3.2). */
export const CSRF_HEADER_VALUE = "1";

/** Serialises a query: repeated keys for arrays, `undefined`/`null` skipped. Returns `""` or `"?…"`. */
export function serializeQuery(query: QueryParams | undefined): string {
  if (!query) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      const items = value as readonly QueryScalar[];
      if (items.length === 0) {
        params.append(key, "");
      }
      for (const item of items) {
        params.append(key, String(item));
      }
      continue;
    }
    params.append(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Percent-encodes one path segment (queue names, job ids — `/` becomes `%2F`). */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

/** Whether a `Content-Type` names JSON (`application/json` or any `+json`). */
function isJsonType(contentType: string): boolean {
  const media = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return media === "application/json" || media.endsWith("+json");
}

/** Whether an error is the fetch's abort, which must propagate untouched. */
function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}

/** Parses JSON text, or returns `undefined` when it is not JSON. */
function tryParse(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/** Turns an error response into an {@link ApiError}. */
function errorFromResponse(response: Response, text: string, path: string) {
  const parsed = isJsonType(response.headers.get("content-type") ?? "")
    ? tryParse(text)
    : undefined;
  if (parsed && isProblem(parsed.value)) {
    return ApiError.fromProblem({ ...parsed.value, status: response.status });
  }
  const snippet = text.trim().slice(0, 300);
  return new ApiError({
    kind: "http",
    status: response.status,
    code: `HTTP_${response.status}`,
    title: response.statusText || `Request failed (${response.status})`,
    detail: snippet || undefined,
    instance: path,
  });
}

/**
 * Creates the API client for a resolved {@link UiConfig}.
 *
 * Every request carries `Accept: application/json` and
 * `credentials: "same-origin"`; POST/PUT/PATCH always carry
 * `Content-Type: application/json`, **even without a body** (the API's
 * `requireJson` answers 415 otherwise); every mutation (POST/PUT/PATCH/DELETE)
 * carries `config.csrfHeader: 1` when one is configured.
 */
export function createApiClient(
  config: Pick<UiConfig, "apiBase" | "csrfHeader">,
  options: ApiClientOptions = {},
): ApiClient {
  const base = config.apiBase.replace(/\/+$/, "");

  async function request<T>(
    method: HttpMethod,
    path: string,
    { query, body, signal }: RequestOptions = {},
  ): Promise<T> {
    const url = `${base}${path}${serializeQuery(query)}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (JSON_METHODS.has(method)) {
      headers["Content-Type"] = "application/json";
    }
    if (config.csrfHeader && MUTATING_METHODS.has(method)) {
      headers[config.csrfHeader] = CSRF_HEADER_VALUE;
    }
    const init: RequestInit = {
      method,
      headers,
      credentials: "same-origin",
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    if (signal) {
      init.signal = signal;
    }

    const fetcher = options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetcher(url, init);
    } catch (error) {
      if (isAbort(error, signal)) {
        throw error;
      }
      throw new ApiError({
        kind: "network",
        status: 0,
        code: "NETWORK_ERROR",
        title: "The API could not be reached",
        detail: error instanceof Error ? error.message : String(error),
        instance: path,
        cause: error,
      });
    }

    if (response.status === 204 || response.status === 205) {
      return undefined as T;
    }
    const text = await response.text();
    if (!response.ok) {
      throw errorFromResponse(response, text, path);
    }
    if (text === "") {
      return undefined as T;
    }
    const parsed = isJsonType(response.headers.get("content-type") ?? "")
      ? tryParse(text)
      : undefined;
    if (!parsed) {
      throw new ApiError({
        kind: "parse",
        status: response.status,
        code: "INVALID_RESPONSE",
        title: "The API answered something other than JSON",
        detail: text.trim().slice(0, 300) || undefined,
        instance: path,
      });
    }
    return parsed.value as T;
  }

  return {
    base,
    request,
    getMeta: (signal) => request<MetaDto>("GET", "/meta", { signal }),
    getPermissions: (target, signal) =>
      request<Permissions>("GET", "/meta/permissions", {
        query: { queue: target?.queue, runner: target?.runner },
        signal,
      }),
    getOverview: (minutes, signal) =>
      request<Overview>("GET", "/overview", { query: { minutes }, signal }),
    listQueues: (search, signal) =>
      request<QueueList>("GET", "/queues", {
        // An empty search is the same as none; the key is left out.
        query: { search: search || undefined },
        signal,
      }),
    getQueueThroughput: (queue, minutes, signal) =>
      request<QueueThroughput>("GET", `/queues/${segment(queue)}/throughput`, {
        query: { minutes },
        signal,
      }),
    listWorkers: (signal) => request<WorkerList>("GET", "/workers", { signal }),
    pauseQueue: (queue) =>
      request<PausedResult>("POST", `/queues/${segment(queue)}/pause`),
    resumeQueue: (queue) =>
      request<PausedResult>("POST", `/queues/${segment(queue)}/resume`),
  };
}
