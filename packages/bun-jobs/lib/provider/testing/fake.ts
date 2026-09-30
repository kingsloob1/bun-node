import type { Server } from "bun";
import { Buffer } from "node:buffer";
import { ConfigError } from "../../shared/errors";

/**
 * Fake platforms (plugins §12.4): a local stand-in for a platform's control
 * API, served by `Bun.serve` on port 0. The author writes the routes and,
 * where the platform's error shapes matter, the fault renderings;
 * {@link fakePlatform} does the rest: units, a token memory, fault queues,
 * and a log of every request, which the conformance kit reads.
 */

/** The faults a fake must be able to reproduce. */
export type FakeFault =
  | "transient"
  | "throttled"
  | "quota"
  | "auth"
  | "misconfigured"
  | "conflict"
  | "capacity-200"
  | "slow";

/** One unit the fake started. */
export interface FakeUnit {
  /** The handle the fake returned for it: `unit-1`, `unit-2`, … */
  readonly handle: string;
  /** The env it was given (empty when the platform passes none). */
  readonly env: Readonly<Record<string, string>>;
  /** The argv it was given. */
  readonly argv: readonly string[];
  /**
   * Where it is: `"pending"` once started, `"running"` once the conformance
   * kit's fixture worker is up for it, `"exited"` once stopped or exited.
   */
  readonly state: "pending" | "running" | "exited";
}

/** What a unit is started with. */
export interface FakeUnitStart {
  /** Its command-line arguments: the request's `argv`, as the platform received it. */
  argv?: readonly string[];
  /** Its environment. */
  env?: Readonly<Record<string, string>>;
}

/** What a route handler receives beside the request: the fake's bookkeeping. */
export interface FakePlatformState {
  /** Where the fake listens, e.g. `http://127.0.0.1:41234`. */
  readonly url: string;
  /**
   * Starts one unit, as the platform would: records it as `"pending"` and,
   * during the kit's handoff check, starts the fixture worker for it with
   * its `argv`. With a `token`, remembers the unit under it for
   * {@link FakePlatformState.recall}.
   */
  start: (
    unit?: FakeUnitStart & {
      /** The dedupe token the request carried, when the platform takes one. */
      token?: string;
    },
  ) => FakeUnit;
  /**
   * The units an earlier request with this dedupe token started, or
   * `undefined` for a token not seen yet. A route answers a remembered token
   * the way the platform does ("deduped"). Every token passed here or to
   * `start` is what the kit's dedupe checks read, so a platform that takes a
   * token must pass it.
   */
  recall: (token: string) => readonly FakeUnit[] | undefined;
  /** One unit by handle, or `undefined`. */
  unit: (handle: string) => FakeUnit | undefined;
  /** Every unit started so far, in order. */
  readonly units: readonly FakeUnit[];
  /**
   * Stops a unit: a pending or running one becomes `"exited"`, and its
   * fixture worker, if the kit started one, is sent `SIGTERM`. Answers
   * `false` for an unknown handle.
   */
  stop: (handle: string) => boolean;
  /** How many units are pending or running: a scale platform's count. */
  readonly count: number;
  /**
   * Sets a scale platform's count: starts units until `target` are pending
   * or running, or stops the newest beyond it. Answers the live units.
   */
  scale: (
    target: number,
    unit?: FakeUnitStart & {
      /** The dedupe token the request carried, remembered for the units it starts. */
      token?: string;
    },
  ) => readonly FakeUnit[];
}

/** A route: a request in, the platform's response out. */
export type FakeRoute = (
  request: Request,
  platform: FakePlatformState,
) => Response | Promise<Response>;

/** A local stand-in for a platform's control API, served on port 0. */
export interface FakePlatform {
  /** Where the fake listens. The kit also routes `ctx.fetch` here. */
  readonly url: string;
  /**
   * Makes the next call(s) fail the way the real platform fails for this
   * fault: its status, its error body, its headers (the `faults` renderings
   * given to {@link fakePlatform}, else generic ones). `"slow"` holds the
   * response until the caller aborts. The fake's author is responsible for
   * fidelity: a fake proves nothing about the platform itself.
   */
  inject: (
    fault: FakeFault,
    options?: {
      /** How many calls fail this way. Defaults to `1`. */
      times?: number;
      /** The wait a `"throttled"` (or `"quota"`) answer asks for, in ms. Defaults to `1_000`. */
      retryAfterMs?: number;
    },
  ) => void;
  /** Units the fake has started, with what they were given. */
  units: () => Promise<readonly FakeUnit[]>;
  /**
   * Sets what starts a unit's process: the kit sets it during its handoff
   * check, to spawn its fixture worker; `undefined` clears it. Units started
   * with none set stay `"pending"`.
   */
  onStart: (handler: ((unit: FakeUnit) => void) | undefined) => void;
  /** The platform's real limits, for the truthfulness checks. */
  readonly limits?: {
    /** The longest one unit may run, in ms. */
    maxDurationMs?: number;
    /** The largest request body the platform accepts, in bytes. */
    maxRequestBytes?: number;
    /** The longest dedupe token the platform accepts. */
    tokenMaxLength?: number;
  };
  /** Stops the server, releases held responses, and stops every unit. */
  close: () => Promise<void>;
}

/** What {@link fakePlatform} takes beside its routes. */
export interface FakePlatformOptions {
  /** The platform's real limits (see {@link FakePlatform.limits}). */
  limits?: FakePlatform["limits"];
  /**
   * How the platform answers each fault, when its shape matters to the
   * provider: the status, error body and headers the real platform sends.
   * A fault without one gets a generic rendering: `transient` 503,
   * `throttled` 429 with `Retry-After` (seconds), `quota` 403, `auth` 401,
   * `misconfigured` 404, `conflict` 409, each with a JSON body
   * `{ "error": { "code", "message" } }`, and `capacity-200` a 200 with
   * `{ "units": [], "failures": [{ "reason": "capacity" }] }`.
   */
  faults?: Partial<
    Record<
      Exclude<FakeFault, "slow">,
      (
        request: Request,
        fault: {
          /** The wait the injection asked for, in ms. */
          retryAfterMs: number;
        },
      ) => Response | Promise<Response>
    >
  >;
}

/** Internal: one request the fake received. */
export interface FakeRequestRecord {
  /** The method. */
  method: string;
  /** The path and query. */
  path: string;
  /** The headers, lowercased, less the kit's routing tag. */
  headers: Record<string, string>;
  /** The body, as text. */
  body: string;
  /** Whether it came through the kit's `ctx.fetch`. */
  routed: boolean;
  /** The fault it was answered with, if one. */
  fault?: FakeFault;
  /** Whether it matched a route. */
  matched: boolean;
}

/** Internal: what the kit reads and drives on a fake. */
export interface FakeInternals {
  /** Every request, in order. */
  readonly requests: FakeRequestRecord[];
  /** Every dedupe token a route passed to `start` or `recall`, in order. */
  readonly tokens: string[];
  /** The header the kit's `ctx.fetch` tags requests with, and its value. */
  readonly tag: { header: string; value: string };
  /** Moves a unit to `state` (the kit's fixture worker came up or exited). */
  mark: (handle: string, state: FakeUnit["state"]) => void;
  /** Registers how to stop a unit's process. */
  onStop: (handle: string, stop: () => void) => void;
  /** Drops faults still queued. */
  clearFaults: () => void;
  /** Faults still queued. */
  pendingFaults: () => number;
  /** Answers every response a `"slow"` fault is holding. */
  releaseHolds: () => void;
  /** How many units have been started. */
  unitCount: () => number;
  /** One unit by handle, or `undefined`. */
  unit: (handle: string) => FakeUnit | undefined;
  /** How many units are pending or running. */
  liveCount: () => number;
}

/** A fake's internals, by the fake. */
const INTERNALS = new WeakMap<FakePlatform, FakeInternals>();

/** Internal: a fake's internals, for the kit. */
export function fakeInternals(platform: FakePlatform): FakeInternals {
  const internals = INTERNALS.get(platform);
  if (internals === undefined) {
    throw new ConfigError(
      "platform must be a FakePlatform from fakePlatform()",
    );
  }
  return internals;
}

/** The header the kit tags its requests with. Internal: the kit and the fake agree on it. */
const TAG_HEADER = "x-bun-jobs-conformance";

/** The longest a `"slow"` fault holds a response before answering normally, in ms. */
const SLOW_HOLD_MS = 30_000;

/** The timer functions as they were when this module loaded, so the kit's timer check never counts the fake's own. */
const { setTimeout: startTimer, clearTimeout: stopTimer } = globalThis;

/** The HTTP methods a route key may name. */
const METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/** The generic status and code for each fault. */
const GENERIC: Record<
  Exclude<FakeFault, "slow" | "capacity-200">,
  [number, string]
> = {
  transient: [503, "ServiceUnavailable"],
  throttled: [429, "Throttled"],
  quota: [403, "QuotaExceeded"],
  auth: [401, "Unauthorized"],
  misconfigured: [404, "NotFound"],
  conflict: [409, "Conflict"],
};

/** The generic rendering of a fault. */
function genericFault(
  fault: Exclude<FakeFault, "slow">,
  retryAfterMs: number,
): Response {
  if (fault === "capacity-200") {
    return Response.json({ units: [], failures: [{ reason: "capacity" }] });
  }
  const [status, code] = GENERIC[fault];
  return Response.json(
    { error: { code, message: `injected ${fault} fault` } },
    {
      status,
      headers:
        fault === "throttled"
          ? { "retry-after": String(Math.ceil(retryAfterMs / 1_000)) }
          : {},
    },
  );
}

/** A random hex string. */
function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "hex",
  );
}

/**
 * Builds a fake platform from its routes: `Bun.serve` on port 0, plus unit
 * bookkeeping, a token memory and fault injection, so a fake for a new
 * platform is its routes and error bodies only.
 *
 * A route key is `"METHOD /path"` or `"/path"` (any method), in `Bun.serve`'s
 * route syntax: `:name` segments arrive on `request.params`.
 *
 * ```ts
 * const platform = await fakePlatform({
 *   "POST /v1/runs": async (request, state) => {
 *     const body = (await request.json()) as { token: string; args: string[] };
 *     const earlier = state.recall(body.token);
 *     if (earlier) return Response.json({ deduped: true, handles: earlier.map((u) => u.handle) });
 *     const unit = state.start({ argv: body.args, token: body.token });
 *     return Response.json({ handles: [unit.handle] }, { status: 201 });
 *   },
 * });
 * ```
 *
 * @throws {ConfigError} for a malformed route key, or one path given both
 *   with and without a method.
 */
export async function fakePlatform(
  routes: Record<string, FakeRoute>,
  options: FakePlatformOptions = {},
): Promise<FakePlatform> {
  const units: FakeUnit[] = [];
  const byHandle = new Map<string, FakeUnit>();
  const byToken = new Map<string, FakeUnit[]>();
  const stoppers = new Map<string, () => void>();
  const faults: { fault: FakeFault; retryAfterMs: number }[] = [];
  const holds = new Set<() => void>();
  const requests: FakeRequestRecord[] = [];
  const tokens: string[] = [];
  const tag = { header: TAG_HEADER, value: randomHex(12) };
  let starter: ((unit: FakeUnit) => void) | undefined;
  let next = 0;
  let url = "";

  const mark = (handle: string, state: FakeUnit["state"]): void => {
    const unit = byHandle.get(handle);
    if (unit === undefined || unit.state === "exited") {
      return;
    }
    const moved: FakeUnit = Object.freeze({ ...unit, state });
    byHandle.set(handle, moved);
    units[units.indexOf(unit)] = moved;
    for (const list of byToken.values()) {
      const index = list.indexOf(unit);
      if (index !== -1) {
        list[index] = moved;
      }
    }
  };

  const live = (): FakeUnit[] =>
    units.filter((unit) => unit.state !== "exited");

  const state: FakePlatformState = {
    get url() {
      return url;
    },
    start: (unit = {}) => {
      const started: FakeUnit = Object.freeze({
        handle: `unit-${++next}`,
        env: Object.freeze({ ...unit.env }),
        argv: Object.freeze([...(unit.argv ?? [])]),
        state: "pending" as const,
      });
      units.push(started);
      byHandle.set(started.handle, started);
      if (unit.token !== undefined) {
        tokens.push(unit.token);
        const list = byToken.get(unit.token) ?? [];
        list.push(started);
        byToken.set(unit.token, list);
      }
      starter?.(started);
      return byHandle.get(started.handle)!;
    },
    recall: (token) => {
      tokens.push(token);
      const list = byToken.get(token);
      return list === undefined ? undefined : [...list];
    },
    unit: (handle) => byHandle.get(handle),
    get units() {
      return [...units];
    },
    stop: (handle) => {
      const unit = byHandle.get(handle);
      if (unit === undefined) {
        return false;
      }
      if (unit.state !== "exited") {
        mark(handle, "exited");
        stoppers.get(handle)?.();
      }
      return true;
    },
    get count() {
      return live().length;
    },
    scale: (target, unit) => {
      const running = live();
      for (let index = running.length; index < target; index++) {
        state.start(unit);
      }
      for (const extra of running.slice(Math.max(0, target)).reverse()) {
        state.stop(extra.handle);
      }
      return live();
    },
  };

  /** Records a request, answers a queued fault, or hands it to the route. */
  const serve = async (
    request: Request,
    route: FakeRoute | undefined,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    let routed = false;
    request.headers.forEach((value, key) => {
      if (key === TAG_HEADER) {
        routed = value === tag.value;
      } else {
        headers[key] = value;
      }
    });
    const path = new URL(request.url);
    const record: FakeRequestRecord = {
      method: request.method,
      path: `${path.pathname}${path.search}`,
      headers,
      body: await request.clone().text(),
      routed,
      matched: route !== undefined,
    };
    requests.push(record);
    if (route === undefined) {
      return Response.json(
        {
          error: {
            code: "NoRoute",
            message: `no route for ${request.method} ${path.pathname}`,
          },
        },
        { status: 404 },
      );
    }
    const fault = faults.shift();
    if (fault !== undefined) {
      record.fault = fault.fault;
      if (fault.fault === "slow") {
        const aborted = await new Promise<boolean>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const hold = { release: (): void => {} };
          const settle = (released: boolean): void => {
            stopTimer(timer);
            holds.delete(hold.release);
            request.signal.removeEventListener("abort", hold.release);
            resolve(released);
          };
          hold.release = () => settle(true);
          timer = startTimer(settle, SLOW_HOLD_MS, false);
          holds.add(hold.release);
          request.signal.addEventListener("abort", hold.release);
        });
        if (aborted) {
          return new Response(null, { status: 504 });
        }
      } else {
        const render = options.faults?.[fault.fault];
        return render === undefined
          ? genericFault(fault.fault, fault.retryAfterMs)
          : await render(request, { retryAfterMs: fault.retryAfterMs });
      }
    }
    return await route(request, state);
  };

  // Group the routes by path, each path either one handler or one per method.
  const table: Record<
    string,
    | ((request: Request) => Promise<Response>)
    | Record<string, (request: Request) => Promise<Response>>
  > = {};
  for (const [key, route] of Object.entries(routes)) {
    const match = /^(?:([A-Z]+)\s+)?(\/\S*)$/.exec(key.trim());
    if (
      match === null ||
      typeof route !== "function" ||
      (match[1] !== undefined && !METHODS.has(match[1]))
    ) {
      throw new ConfigError(
        `fakePlatform: a route key is "METHOD /path" or "/path", and its value a handler`,
        { route: key },
      );
    }
    const [, method, path] = match as unknown as [string, string, string];
    const handler = async (request: Request): Promise<Response> =>
      await serve(request, route);
    const existing = table[path];
    if (method === undefined) {
      if (existing !== undefined) {
        throw new ConfigError(
          "fakePlatform: a path is given both with and without a method",
          { route: key },
        );
      }
      table[path] = handler;
    } else {
      if (typeof existing === "function") {
        throw new ConfigError(
          "fakePlatform: a path is given both with and without a method",
          { route: key },
        );
      }
      table[path] = { ...existing, [method]: handler };
    }
  }

  const server: Server<undefined> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    routes: table,
    fetch: async (request) => await serve(request, undefined),
  });
  url = `http://127.0.0.1:${server.port}`;

  const members: FakePlatform = {
    url,
    inject: (fault, injection) => {
      const times = injection?.times ?? 1;
      if (!Number.isSafeInteger(times) || times < 1) {
        throw new ConfigError("inject: times must be a positive whole number", {
          times,
        });
      }
      for (let index = 0; index < times; index++) {
        faults.push({ fault, retryAfterMs: injection?.retryAfterMs ?? 1_000 });
      }
    },
    units: async () => [...units],
    onStart: (handler) => {
      starter = handler;
    },
    ...(options.limits === undefined
      ? {}
      : { limits: Object.freeze({ ...options.limits }) }),
    close: async () => {
      for (const release of [...holds]) {
        release();
      }
      for (const unit of live()) {
        state.stop(unit.handle);
      }
      await server.stop(true);
    },
  };
  const platform: FakePlatform = Object.freeze(members);
  INTERNALS.set(platform, {
    requests,
    tokens,
    tag,
    mark,
    onStop: (handle, stop) => {
      stoppers.set(handle, stop);
    },
    clearFaults: () => {
      faults.length = 0;
    },
    pendingFaults: () => faults.length,
    unitCount: () => units.length,
    unit: (handle) => byHandle.get(handle),
    liveCount: () => live().length,
    releaseHolds: () => {
      for (const release of [...holds]) {
        release();
      }
    },
  });
  return platform;
}
