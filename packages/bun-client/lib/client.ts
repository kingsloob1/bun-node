/**
 * `createClient`: the request builder and its pipeline (typed-client plan
 * §6.1, §6.2). One call runs, in order:
 *
 * 1. the configuration, merged global → route → call (§6.2's table);
 * 2. the URL (params into the path literal, the query serialised as
 *    bun-common's parser reads it) and the body (JSON, or passed through);
 * 3. one **attempt** per try: a fresh `Request`, the headers of each level
 *    applied in order, the auth token, then the middleware onion, then
 *    `fetch`;
 * 4. **retries** around the attempts, for the configured statuses and
 *    network failures, waiting `Retry-After` or the backoff;
 * 5. **auth refresh** around the retries: a status in `auth.on` runs one
 *    single-flight `refresh()` and sends the request once more;
 * 6. the **result**: a declared status read into `data` or `error`; an
 *    undeclared one thrown (or returned, under `undeclaredStatus: "result"`).
 *
 * **Validation** (§5, PR-C4) wraps it: the params, query and body are
 * checked before the URL is built, the headers on the first attempt before
 * the middleware, and a declared status's body after it is read. The checks
 * live in `./validation`, imported with `import()` only when a call has
 * something to check, so a client with validation off loads neither it nor
 * bun-contract.
 *
 * A `timeout` covers the request, retries and their waits included. The
 * client imports nothing at run time but that lazy module: it is
 * browser-safe, and an HTTP-only bundle carries nothing more (D17).
 */
import type {
  CallConfig,
  Client,
  ClientConfig,
  ClientFlags,
  ClientMiddleware,
  FlagConfig,
  HeadersOption,
  RequestContext,
  RetryConfig,
  RouteConfig,
  RouteMap,
  UndeclaredStatus,
  ValidationConfig,
} from "./types";
import type { CallChecks, Checks } from "./validation";
import {
  ClientError,
  HttpError,
  NetworkError,
  TimeoutError,
  UnexpectedStatusError,
  ValidationError,
} from "./errors";
import { buildPath } from "./path";
import { serializeQuery } from "./querystring";
import { backoffDelay, retryAfterMs } from "./retry";

/** {@link RetryConfig} with every default filled in. */
type ResolvedRetry = Required<RetryConfig>;

/** The built-in retry defaults (§6.2). */
const DEFAULT_RETRY: Readonly<ResolvedRetry> = Object.freeze({
  attempts: 2,
  methods: Object.freeze(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]),
  on: Object.freeze([408, 429, 500, 502, 503, 504, "network"] as const),
  baseMs: 300,
  maxMs: 10_000,
  jitter: 0.5,
  respectRetryAfter: true,
});

/** The default `timeout`, ms (§6.2). */
const DEFAULT_TIMEOUT = 30_000;

/** Statuses whose response carries no body. */
const BODILESS = new Set([204, 205, 304]);

/** The verbs, as the client's method names and the upper-case HTTP methods. */
const VERBS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
] as const;

/** Untyped options as the pipeline reads them. */
interface RuntimeOptions extends CallConfig {
  /** Path params. */
  params?: Readonly<Record<string, unknown>>;
  /** The query object. */
  query?: unknown;
  /** The body: JSON, or a type `fetch` takes as it is. */
  body?: unknown;
}

/** One call's configuration, every level merged. */
interface Resolved {
  /** The timeout, ms, or `false`. */
  timeout: number | false;
  /** The retry settings, or `false`. */
  retry: ResolvedRetry | false;
  /** Whether a declared error status throws. */
  throwOnError: boolean;
  /** What an undeclared status does. */
  undeclaredStatus: UndeclaredStatus;
  /** Headers from each level, in order (client, route, call). */
  headers: (HeadersOption | undefined)[];
  /** The middleware, outermost first. */
  middleware: ClientMiddleware[];
}

/**
 * Whether a validation level could turn a check on: an object with any key
 * but `onFailure` that is not `false`. Decides, with the mode and the schema
 * source, whether a call loads the checks at all, so a production client
 * that configures nothing extra never does.
 */
function mayCheck(level: ValidationConfig | false | undefined): boolean {
  return (
    typeof level === "object" &&
    Object.entries(level).some(
      ([name, value]) =>
        name !== "onFailure" && value !== false && value !== undefined,
    )
  );
}

/**
 * The one `process` read here: `process.env.NODE_ENV`. Declared in this
 * module alone (a type, erased), since `lib/` is browser code checked with no
 * Bun or Node types; at run time it is the global, or a bundler's define.
 */
declare const process: {
  /** The environment; only `NODE_ENV` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
};

/**
 * The mode when the configuration names none (§5.5): `process.env.NODE_ENV`
 * written out, so a bundler's define replaces it; where nothing replaced it
 * and there is no `process` (a browser), development.
 */
function defaultMode(): "development" | "production" {
  try {
    return process.env.NODE_ENV === "production" ? "production" : "development";
  } catch {
    return "development";
  }
}

/** Retry settings merged over the previous level's; `false` turns them off, a later object back on. */
function mergeRetry(
  levels: readonly (RetryConfig | false | undefined)[],
): ResolvedRetry | false {
  let merged: ResolvedRetry | false = DEFAULT_RETRY;
  for (const level of levels) {
    if (level === undefined) continue;
    if (level === false) {
      merged = false;
      continue;
    }
    const base: ResolvedRetry = merged === false ? DEFAULT_RETRY : merged;
    const defined = Object.fromEntries(
      Object.entries(level).filter(([, value]) => value !== undefined),
    ) as RetryConfig;
    merged = { ...base, ...defined };
  }
  return merged;
}

/** A body as `Request` takes it (the DOM's `BodyInit`, or Bun's). */
type BodyLike = NonNullable<RequestInit["body"]>;

/** A body `fetch` takes as it is, rather than as JSON. */
function isRawBody(body: unknown): body is BodyLike {
  return (
    (typeof FormData !== "undefined" && body instanceof FormData) ||
    (typeof URLSearchParams !== "undefined" &&
      body instanceof URLSearchParams) ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

/**
 * Why `signal` aborted: what the call rejects with. Typed `Error` for the
 * throw rules; a caller may abort with any value, and it is passed on as it
 * is (`AbortController.abort(reason)` makes it the platform's `AbortError`
 * when none is given, and the client's own timeout gives a `TimeoutError`).
 */
function reasonOf(signal: AbortSignal): Error {
  return signal.reason as Error;
}

/**
 * `promise`, or a rejection with the signal's reason when it aborts first:
 * so a timeout or an abort ends the call even when a custom `fetch` (an
 * in-process `router.fetch`, a mock) never looks at `request.signal`.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(reasonOf(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error as Error);
      },
    );
  });
}

/** Waits `ms`, or rejects with the signal's reason when it aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(reasonOf(signal));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      clearTimeout(timer);
      reject(reasonOf(signal));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Releases a response the client will not read. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already read or errored: nothing to release.
  }
}

/** A JSON media type: `application/json`, `application/problem+json`, `…+json`. */
function isJsonType(type: string): boolean {
  return /^application\/(?:[\w.-]+\+)?json\b/i.test(type);
}

/**
 * Reads a response body as the declared types expect: JSON parsed; text as a
 * string; no body as `undefined`; an event stream left unread (`undefined`,
 * the stream is still on `response.body`); anything else as a `Blob`.
 */
async function readBody(
  response: Response,
  method: string,
  key: string,
): Promise<unknown> {
  if (method === "HEAD" || BODILESS.has(response.status)) {
    await discard(response);
    return undefined;
  }
  const type = response.headers.get("content-type") ?? "";
  if (/^text\/event-stream\b/i.test(type)) return undefined;
  if (isJsonType(type)) {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ClientError(
        `${key} answered ${response.status} with a body that is not JSON`,
        { key, cause: error },
      );
    }
  }
  if (!type || /^text\//i.test(type)) {
    const text = await response.text();
    return text === "" ? undefined : text;
  }
  return response.blob();
}

/** The current token and the single-flight refresh, shared by every call of one client. */
class AuthState {
  /** A token `refresh()` returned; wins over `config.token` until the next refresh. */
  #refreshed: string | undefined;
  /** Counts completed refreshes, so a call can tell whether its token is stale. */
  generation = 0;
  /** The refresh in flight, shared by every call that failed meanwhile. */
  #inflight: Promise<boolean> | undefined;

  constructor(private readonly config: ClientConfig["auth"]) {}

  /** The token to send now; `undefined` for none. */
  async token(): Promise<string | undefined> {
    if (this.#refreshed !== undefined) return this.#refreshed;
    const source = this.config?.token;
    const value = typeof source === "function" ? await source() : source;
    return value ?? undefined;
  }

  /** The statuses that trigger a refresh, when a refresh is configured. */
  triggers(status: number): boolean {
    if (!this.config?.refresh) return false;
    return (this.config.on ?? [401]).includes(status);
  }

  /**
   * Refreshes once for every call that failed with the token of `generation`:
   * resolves `true` when there is a new token to retry with. A call whose
   * token a refresh already replaced retries without refreshing again.
   */
  refreshFor(generation: number): Promise<boolean> {
    if (this.#inflight) return this.#inflight;
    if (generation !== this.generation) return Promise.resolve(true);
    const refresh = this.config!.refresh!;
    this.#inflight = (async () => {
      try {
        const next = await refresh();
        if (next === null) return false;
        this.#refreshed = next ?? undefined;
        this.generation++;
        return true;
      } finally {
        this.#inflight = undefined;
      }
    })();
    return this.#inflight;
  }
}

/**
 * Creates a typed client over a route map (§6.1).
 *
 * ```ts
 * const api = createClient<Routes>({ baseUrl: "/api" });
 * const r = await api.get("/users/:id", { params: { id: "42" } });
 * if (r.ok) r.data.name;
 * ```
 *
 * @typeParam R The route map, keyed `"VERB /path"`.
 * @typeParam F The configuration that decides a call's return type:
 *   `{ throwOnError: true }` and/or `{ undeclaredStatus: "result" }` when the
 *   configuration sets them (the configuration must then match).
 */
export function createClient<
  R extends RouteMap<R>,
  F extends ClientFlags = Record<never, never>,
>(config?: ClientConfig<R> & FlagConfig<F>): Client<R, F>;
export function createClient(
  config: ClientConfig = {},
): Client<Record<string, never>> {
  const auth = new AuthState(config.auth);
  const logger = config.logger ?? console;
  const routes = (config.routes ?? {}) as Readonly<
    Record<string, RouteConfig | undefined>
  >;
  const manifest = (config.manifest ?? {}) as Readonly<
    Record<
      string,
      { operationId?: string; statuses?: readonly number[] } | undefined
    >
  >;
  const development = (config.mode ?? defaultMode()) === "development";

  /** The checks (`./validation`), imported on the first call that may check something. */
  let checks: Promise<Checks> | undefined;
  const loadChecks = (): Promise<Checks> =>
    (checks ??= import("./validation").then((module) =>
      module.createChecks({
        development,
        source: config.schemas,
        logger,
        errors: { ClientError, ValidationError },
      }),
    ));

  /** The configuration for one call, every level merged (§6.2). */
  const resolve = (key: string, call: RuntimeOptions): Resolved => {
    const route = routes[key] ?? {};
    return {
      timeout:
        call.timeout ?? route.timeout ?? config.timeout ?? DEFAULT_TIMEOUT,
      retry: mergeRetry([config.retry, route.retry, call.retry]),
      throwOnError: call.throwOnError ?? config.throwOnError ?? false,
      undeclaredStatus:
        call.undeclaredStatus ?? config.undeclaredStatus ?? "throw",
      headers: [config.headers, route.headers, call.headers],
      middleware: [
        ...(config.middleware ?? []),
        ...(route.middleware ?? []),
        ...(call.middleware ?? []),
      ],
    };
  };

  /** The URL for `path` with the call's params and query, `baseUrl` included. */
  const urlFor = (path: string, call: RuntimeOptions, key: string): string => {
    const query = serializeQuery(call.query);
    return `${config.baseUrl ?? ""}${buildPath(path, call.params, key)}${query ? `?${query}` : ""}`;
  };

  /** An absolute URL for `Request`, resolving a relative one where that is safe. */
  const absolute = (url: string, key: string): string => {
    if (/^[a-z][a-z\d+.-]*:/i.test(url)) return url;
    const base = (globalThis as { location?: { href?: string } }).location
      ?.href;
    if (base) return new URL(url, base).href;
    if (config.fetch) return new URL(url, "http://localhost").href;
    throw new ClientError(
      `${key}: "${url}" is relative, and there is no page to resolve it against; give an absolute baseUrl, or a fetch that serves relative requests`,
      { key },
    );
  };

  /** Sends one attempt: a fresh request through the headers, auth and middleware. */
  const attempt = async (
    ctxBase: Omit<RequestContext, "request" | "attempt">,
    url: string,
    call: RuntimeOptions,
    resolved: Resolved,
    signal: AbortSignal,
    number: number,
    checkHeaders: ((request: Request) => Promise<void>) | undefined,
  ): Promise<{ response: Response; generation: number }> => {
    const raw = isRawBody(call.body);
    const json = call.body !== undefined && !raw;
    const init: RequestInit & { duplex?: "half" } = {
      method: ctxBase.method,
      credentials: config.credentials ?? "same-origin",
      signal,
      body: json
        ? JSON.stringify(call.body)
        : (call.body as BodyLike | undefined),
      headers: json ? { "content-type": "application/json" } : undefined,
    };
    if (
      typeof ReadableStream !== "undefined" &&
      call.body instanceof ReadableStream
    )
      init.duplex = "half";
    const ctx: RequestContext = {
      ...ctxBase,
      attempt: number,
      request: new Request(url, init),
    };
    for (const level of resolved.headers) {
      if (level === undefined) continue;
      const given = typeof level === "function" ? await level(ctx) : level;
      new Headers(given).forEach((value, name) => {
        ctx.request.headers.set(name, value);
      });
    }
    const generation = auth.generation;
    const token = await auth.token();
    if (token !== undefined && !ctx.request.headers.has("authorization"))
      ctx.request.headers.set("authorization", `Bearer ${token}`);
    // The headers as they are sent, checked once, before any middleware.
    if (number === 1 && checkHeaders !== undefined)
      await checkHeaders(ctx.request);

    const run = async (index: number): Promise<Response> => {
      const middleware = resolved.middleware[index];
      if (middleware) return middleware(ctx, () => run(index + 1));
      // A signal aborted before the send: never hand a custom fetch a dead request.
      if (signal.aborted) throw reasonOf(signal);
      try {
        return await abortable((config.fetch ?? fetch)(ctx.request), signal);
      } catch (error) {
        // Only a rejected fetch is a network failure; an abort stays one.
        if (signal.aborted) throw reasonOf(signal);
        throw new NetworkError(`${ctx.key}: fetch failed`, {
          key: ctx.key,
          cause: error,
        });
      }
    };
    return { response: await run(0), generation };
  };

  /** Attempts with retries (§6.1): statuses, network failures, `Retry-After`, backoff. */
  const withRetries = async (
    ctxBase: Omit<RequestContext, "request" | "attempt">,
    url: string,
    call: RuntimeOptions,
    resolved: Resolved,
    signal: AbortSignal,
    first: number,
    checkHeaders?: (request: Request) => Promise<void>,
  ): Promise<{ response: Response; generation: number; attempts: number }> => {
    const retry =
      resolved.retry !== false &&
      resolved.retry.methods.some(
        (method) => method.toUpperCase() === ctxBase.method,
      ) &&
      !(
        typeof ReadableStream !== "undefined" &&
        call.body instanceof ReadableStream
      )
        ? resolved.retry
        : undefined;
    for (let tries = 1; ; tries++) {
      const number = first + tries - 1;
      let outcome: { response: Response; generation: number } | undefined;
      let failure: NetworkError | undefined;
      try {
        outcome = await attempt(
          ctxBase,
          url,
          call,
          resolved,
          signal,
          number,
          checkHeaders,
        );
      } catch (error) {
        if (signal.aborted) throw reasonOf(signal);
        if (!(error instanceof NetworkError)) throw error;
        failure = error;
      }
      if (!retry || tries > retry.attempts) {
        if (outcome) return { ...outcome, attempts: number };
        throw failure!;
      }
      if (outcome) {
        const { response } = outcome;
        if (!retry.on.includes(response.status))
          return { ...outcome, attempts: number };
        const after = retry.respectRetryAfter
          ? retryAfterMs(response.headers.get("retry-after"))
          : undefined;
        const delay =
          after === undefined
            ? backoffDelay(tries, retry)
            : Math.min(after, retry.maxMs);
        await discard(response);
        logger.debug(
          `${ctxBase.key}: ${response.status}, retry ${tries} of ${retry.attempts} in ${Math.round(delay)} ms`,
        );
        await sleep(delay, signal);
        continue;
      }
      if (!retry.on.includes("network")) throw failure!;
      const delay = backoffDelay(tries, retry);
      logger.debug(
        `${ctxBase.key}: network failure, retry ${tries} of ${retry.attempts} in ${Math.round(delay)} ms`,
      );
      await sleep(delay, signal);
    }
  };

  /** Turns a response into the call's value (§4.3, §4.4). */
  const finish = async (
    response: Response,
    key: string,
    method: string,
    resolved: Resolved,
    callChecks: CallChecks | undefined,
  ): Promise<unknown> => {
    const status = response.status;
    const declared = manifest[key]?.statuses;
    if (declared && !declared.includes(status)) {
      if (resolved.throwOnError || resolved.undeclaredStatus === "throw")
        throw new UnexpectedStatusError(response, declared, key);
      const error = await readBody(response, method, key);
      return { ok: false, status, error, response };
    }
    const read = await readBody(response, method, key);
    const body =
      callChecks === undefined ? read : await callChecks.response(status, read);
    const ok = status >= 200 && status < 300;
    if (resolved.throwOnError) {
      if (ok) return body;
      throw new HttpError(status, body, response, key);
    }
    return ok
      ? { ok, status, data: body, response }
      : { ok, status, error: body, response };
  };

  /** Runs one call by route key. */
  const call = async (
    key: string,
    given: RuntimeOptions = {},
  ): Promise<unknown> => {
    const space = key.indexOf(" ");
    if (space < 1)
      throw new ClientError(`"${key}" is not a route key ("VERB /path")`, {
        key,
      });
    const method = key.slice(0, space).toUpperCase();
    const path = key.slice(space + 1);
    const resolved = resolve(key, given);
    const levels = [config.validate, routes[key]?.validate, given.validate];
    const callChecks =
      (development && config.schemas !== undefined) || levels.some(mayCheck)
        ? (await loadChecks())(key, levels)
        : undefined;
    // What is sent: the call's options, with a passing BYO schema's output.
    const options =
      callChecks === undefined ? given : await callChecks.request(given);
    const url = absolute(urlFor(path, options, key), key);

    const timeout = new AbortController();
    const timer =
      resolved.timeout === false
        ? undefined
        : setTimeout(
            () =>
              timeout.abort(new TimeoutError(resolved.timeout as number, key)),
            resolved.timeout,
          );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout.signal])
      : timeout.signal;
    const ctxBase = {
      key,
      method,
      path,
      options: options as Readonly<Record<string, unknown>>,
    };
    try {
      let { response, generation, attempts } = await withRetries(
        ctxBase,
        url,
        options,
        resolved,
        signal,
        1,
        callChecks?.headers,
      );
      if (
        auth.triggers(response.status) &&
        (await auth.refreshFor(generation))
      ) {
        await discard(response);
        ({ response, generation, attempts } = await withRetries(
          ctxBase,
          url,
          options,
          resolved,
          signal,
          attempts + 1,
        ));
      }
      return await finish(response, key, method, resolved, callChecks);
    } catch (error) {
      // Whichever aborted first, the caller or the timeout (the combined
      // signal keeps the first reason), over whatever the abort caused.
      if (signal.aborted) throw reasonOf(signal);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const client: Record<string, unknown> = {
    request: call,
    url: (path: string, options: RuntimeOptions = {}) =>
      urlFor(path, options, path),
  };
  for (const verb of VERBS) {
    const method = verb.toUpperCase();
    client[verb] = (path: string, options?: RuntimeOptions) =>
      call(`${method} ${path}`, options);
  }

  const byOperation = new Map<string, string>();
  for (const [key, facts] of Object.entries(manifest)) {
    if (facts?.operationId) byOperation.set(facts.operationId, key);
  }
  client.op = new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== "string") return undefined;
        const key = byOperation.get(name);
        if (!key) {
          return () =>
            Promise.reject(
              new ClientError(
                `No operation "${name}" in the client's manifest`,
              ),
            );
        }
        return (options?: RuntimeOptions) => call(key, options);
      },
    },
  );
  return client as unknown as Client<Record<string, never>>;
}
