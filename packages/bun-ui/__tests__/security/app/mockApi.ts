/**
 * A fake security API for the app's DOM tests: answers by `"METHOD /path"`
 * (the path under `apiBase`), records every call, and answers 404 for
 * anything unrouted. Fixtures are the API's real response shapes.
 */
import type { Routes } from "../../../app/security/api/routes.gen";

/** One recorded call. */
export interface MockCall {
  /** The method. */
  readonly method: string;
  /** The path under the API's base. */
  readonly path: string;
  /** The query. */
  readonly query: URLSearchParams;
  /** The headers, lower-cased names. */
  readonly headers: Headers;
  /** The body, parsed when JSON. */
  readonly body: unknown;
}

/** A canned reply. */
export interface MockReply {
  /** The status. Default 200. */
  status?: number;
  /** The JSON body. */
  body?: unknown;
}

/** A computed reply. */
export type MockHandler = (
  call: MockCall,
) => MockReply | Response | Promise<MockReply | Response>;

/** The fake. */
export interface MockApi {
  /** The `fetch` to give the client. */
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Every call so far. */
  readonly calls: MockCall[];
  /** Replaces or adds routes. */
  readonly route: (routes: Record<string, MockHandler | MockReply>) => void;
}

/** A problem body as the API sends it. */
export function problem(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): MockReply {
  return {
    status,
    body: {
      type: `urn:bun-security:problem:${code}`,
      title: code,
      status,
      code,
      ...extra,
    },
  };
}

/** Every permission, set to `value`. */
export function allPermissions(
  value: boolean,
): Routes["GET /meta/permissions"]["responses"][200]["permissions"] {
  const names = [
    "services:read",
    "services:write",
    "groups:read",
    "groups:write",
    "identities:read",
    "identities:write",
    "policy:read",
    "policy:draft",
    "policy:publish",
    "bundles:read",
    "approvals:read",
    "roles:read",
    "roles:write",
    "audit:read",
    "audit:export",
    "agents:read",
    "agents:write",
    "bans:read",
    "bans:write",
    "analytics:read",
    "events:read",
    "alerts:read",
    "alerts:write",
    "rules:test",
  ] as const;
  return Object.fromEntries(
    names.map((name) => [name, value]),
  ) as Routes["GET /meta/permissions"]["responses"][200]["permissions"];
}

/** `GET /meta`. */
export function metaFixture(
  overrides: Partial<Routes["GET /meta"]["responses"][200]> = {},
): Routes["GET /meta"]["responses"][200] {
  return {
    protocolVersion: 1,
    version: "3.3.0",
    basePath: "/security/api",
    csrfHeader: "x-bun-security-csrf",
    stepUp: "none",
    approvals: "off",
    signingKeyId: "sk_t",
    builtInRbac: true,
    breakGlass: false,
    store: { name: "memory", durable: false },
    ...overrides,
  };
}

/** An operator's permissions per scope; a scope not listed gets `fallback`. */
export type PermissionTable = Record<
  string,
  Partial<Record<keyof ReturnType<typeof allPermissions>, boolean>>
>;

/**
 * The fixtures' instant: the start of the hour two hours ago, so it falls in
 * every preset range and in the closed hours a range reads at the hour tier.
 */
export const T0 =
  Math.floor(Date.now() / 3_600_000) * 3_600_000 - 2 * 3_600_000;

/** Whether `at` is inside a call's `[from, to)` (no bounds: always). */
function within(call: MockCall, at: number): boolean {
  const from = Number(call.query.get("from") ?? -Infinity);
  const to = Number(call.query.get("to") ?? Infinity);
  return at >= from && at < to;
}

/**
 * The analytics page's reads (PR-U2), each a real answer's shape: a series
 * of `requests` by action (12 allowed, 3 blocked) and empty other metrics,
 * empty top-Ns, a distinct count, no scores, an empty ban timeline with 2
 * bans in force, and no events.
 */
export function analyticsRoutes(
  options: {
    /** A series' points by metric (default: requests only). */
    series?: Record<
      string,
      {
        at: number;
        dims: Record<string, string>;
        value: number;
        service?: string;
      }[]
    >;
    /** A top-N's rows by metric. */
    top?: Record<string, { dims: Record<string, string>; value: number }[]>;
  } = {},
): Record<string, MockHandler | MockReply> {
  const series = options.series ?? {
    requests: [
      { at: T0, dims: { action: "allow" }, value: 12 },
      { at: T0, dims: { action: "block" }, value: 3 },
    ],
  };
  return {
    "GET /analytics/series": (call) => ({
      body: {
        tier: call.query.get("tier") ?? "minute",
        points: (series[call.query.get("metric") ?? ""] ?? []).filter((point) =>
          within(call, point.at),
        ),
      },
    }),
    // A top-N's rows are T0's: answered by the call whose range holds it.
    "GET /analytics/top": (call) => ({
      body: {
        rows: within(call, T0)
          ? (options.top?.[call.query.get("metric") ?? ""] ?? [])
          : [],
      },
    }),
    "GET /analytics/distinct": { body: { count: 3, other: false } },
    "GET /analytics/scores": { body: { rows: [], truncated: false } },
    "GET /analytics/bans": {
      body: { bucketMs: 3_600_000, points: [], active: 2, truncated: false },
    },
    "GET /analytics/events": { body: { items: [] } },
  };
}

/** The routes every screen reads: an owner of everything unless overridden. */
export function defaultRoutes(
  options: {
    /** Each scope's permissions (merged over all-false); default: all true everywhere. */
    permissions?: PermissionTable;
    /** The operator's role bindings. */
    roles?: Routes["GET /operators/me"]["responses"][200]["roles"];
    /** The client address `/operators/me` reports. Default `null`. */
    address?: string | null;
  } = {},
): Record<string, MockHandler | MockReply> {
  const table = options.permissions;
  return {
    "GET /meta": { body: metaFixture() },
    "GET /meta/permissions": (call) => {
      const scope = call.query.get("scope") ?? "global";
      return {
        body: {
          scope,
          permissions:
            table === undefined
              ? allPermissions(true)
              : { ...allPermissions(false), ...table[scope] },
        },
      };
    },
    "GET /operators/me": {
      body: {
        id: "op",
        name: "Operator",
        roles: options.roles ?? [
          { role: "owner", scope: "global", source: "owners" },
        ],
        address: options.address ?? null,
      },
    },
    "GET /groups": { body: { items: [{ id: "payments" }] } },
    "GET /services": {
      body: { items: [{ id: "checkout" }, { id: "ledger" }] },
    },
    "GET /policies/:scope": { body: { scope: "global", head: { number: 3 } } },
    "GET /bans": {
      body: {
        items: ["198.51.100.1", "203.0.113.7"].map((ip, index) => ({
          id: `b${index + 1}`,
          scope: "global",
          subject: { type: "ip", value: ip },
          action: "ban",
          reason: "fixture",
          source: "manual",
          createdAt: T0,
          expiresAt: null,
          count: 1,
          liftedAt: null,
          active: true,
          revision: 1,
        })),
      },
    },
    "GET /agents": {
      body: {
        items: [
          {
            id: "a1",
            service: "checkout",
            status: "ok",
            lastSeen: T0,
            reported: null,
          },
          {
            id: "a2",
            service: "ledger",
            status: "late",
            lastSeen: T0,
            reported: null,
          },
        ],
      },
    },
    ...analyticsRoutes(),
    "GET /openapi.json": {
      body: {
        openapi: "3.1.0",
        info: { title: "Security API", version: "1" },
        paths: {
          "/meta": {
            get: {
              operationId: "getMeta",
              summary: "What this API is",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      },
    },
    "GET /audit/verify": {
      body: {
        ok: true,
        checked: 12,
        first: 1,
        last: 12,
        checkpoints: { checked: 0, latest: null },
        external: "none-configured",
        problems: [],
        unconfirmed: [],
      },
    },
  };
}

/** The route key matching `method path`: exact, else a `:param` pattern. */
function match(
  routes: Map<string, MockHandler | MockReply>,
  method: string,
  path: string,
) {
  const exact = routes.get(`${method} ${path}`);
  if (exact !== undefined) return exact;
  for (const [key, handler] of routes) {
    const [verb, pattern] = key.split(" ") as [string, string];
    if (verb !== method) continue;
    const re = new RegExp(`^${pattern.replace(/:[^/]+/g, "[^/]+")}$`);
    if (re.test(path)) return handler;
  }
  return undefined;
}

/** A fake API at `base`. */
export function mockApi(
  base: string,
  routes: Record<string, MockHandler | MockReply>,
): MockApi {
  const table = new Map(Object.entries(routes));
  const calls: MockCall[] = [];
  return {
    calls,
    route: (more) => {
      for (const [key, value] of Object.entries(more)) table.set(key, value);
    },
    fetch: async (input, init) => {
      const url = new URL(input, "http://localhost");
      const path = url.pathname.startsWith(base)
        ? url.pathname.slice(base.length) || "/"
        : url.pathname;
      const method = (init.method ?? "GET").toUpperCase();
      let body: unknown;
      if (typeof init.body === "string" && init.body !== "") {
        try {
          body = JSON.parse(init.body) as unknown;
        } catch {
          body = init.body;
        }
      }
      const call: MockCall = {
        method,
        path,
        query: url.searchParams,
        headers: new Headers(init.headers),
        body,
      };
      calls.push(call);
      const handler = match(table, method, path);
      const reply =
        handler === undefined
          ? problem(404, "not_found")
          : typeof handler === "function"
            ? await handler(call)
            : handler;
      if (reply instanceof Response) return reply;
      const status = reply.status ?? 200;
      const contentType =
        status >= 400 ? "application/problem+json" : "application/json";
      return new Response(
        reply.body === undefined ? null : JSON.stringify(reply.body),
        {
          status,
          headers: { "content-type": contentType },
        },
      );
    },
  };
}
