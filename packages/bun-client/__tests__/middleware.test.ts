/**
 * Middleware (plan §6.1, §6.2): an onion of `(ctx, next) => Promise<Response>`,
 * concatenated client (outermost), route, call (innermost); each runs once
 * per attempt, sees the route key, the options and a mutable `Request`, and
 * may answer without calling `next()`.
 */
import type { ClientMiddleware } from "../lib/index";
import { describe, expect, it } from "bun:test";
import { createClient } from "../lib/index";

interface Routes {
  "GET /users/:id": {
    params: { id: string };
    responses: { 200: { id: string; trace: string | null } };
  };
}

/** A middleware that records entering and leaving under `name`. */
function recorder(name: string, log: string[]): ClientMiddleware {
  return async (_ctx, next) => {
    log.push(`${name}:in`);
    const response = await next();
    log.push(`${name}:out`);
    return response;
  };
}

/** A fetch answering with the id and the trace header it received. */
const echo = async (request: Request) =>
  Response.json({
    id: new URL(request.url).pathname.split("/").at(-1),
    trace: request.headers.get("traceparent"),
  });

describe("middleware order", () => {
  it("runs client → route → call on the way in, and back out in reverse", async () => {
    const log: string[] = [];
    const api = createClient<Routes>({
      fetch: async (request) => {
        log.push("fetch");
        return echo(request);
      },
      middleware: [recorder("client1", log), recorder("client2", log)],
      routes: { "GET /users/:id": { middleware: [recorder("route", log)] } },
    });
    await api.get("/users/:id", {
      params: { id: "1" },
      middleware: [recorder("call", log)],
    });
    expect(log).toEqual([
      "client1:in",
      "client2:in",
      "route:in",
      "call:in",
      "fetch",
      "call:out",
      "route:out",
      "client2:out",
      "client1:out",
    ]);
  });

  it("gives each middleware the route key, the options, the attempt and the request", async () => {
    const seen: unknown[] = [];
    const api = createClient<Routes>({
      fetch: echo,
      middleware: [
        async (ctx, next) => {
          seen.push({
            key: ctx.key,
            method: ctx.method,
            path: ctx.path,
            attempt: ctx.attempt,
            url: ctx.request.url,
            params: ctx.options.params,
          });
          return next();
        },
      ],
    });
    await api.get("/users/:id", { params: { id: "7" } });
    expect(seen).toEqual([
      {
        key: "GET /users/:id",
        method: "GET",
        path: "/users/:id",
        attempt: 1,
        url: "http://localhost/users/7",
        params: { id: "7" },
      },
    ]);
  });

  it("lets a middleware change the request: a header, or a new Request", async () => {
    const api = createClient<Routes>({
      fetch: echo,
      middleware: [
        async (ctx, next) => {
          ctx.request.headers.set("traceparent", "00-trace-01");
          return next();
        },
        async (ctx, next) => {
          ctx.request = new Request(
            ctx.request.url.replace("/7", "/8"),
            ctx.request,
          );
          return next();
        },
      ],
    });
    const result = await api.get("/users/:id", { params: { id: "7" } });
    expect(result.ok && result.data).toEqual({ id: "8", trace: "00-trace-01" });
  });

  it("lets a middleware answer without calling next (a mock), and the inner ones never run", async () => {
    const log: string[] = [];
    let fetched = 0;
    const api = createClient<Routes>({
      fetch: async (request) => {
        fetched++;
        return echo(request);
      },
      middleware: [
        recorder("outer", log),
        async () => Response.json({ id: "mock", trace: null }),
        recorder("inner", log),
      ],
    });
    const result = await api.get("/users/:id", { params: { id: "1" } });
    expect(result.ok && result.data.id).toBe("mock");
    expect(log).toEqual(["outer:in", "outer:out"]);
    expect(fetched).toBe(0);
  });

  it("runs once per attempt, inside the retries", async () => {
    let attempts = 0;
    const seen: number[] = [];
    const api = createClient<Routes>({
      retry: { baseMs: 1, jitter: 0 },
      fetch: async (request) =>
        ++attempts < 3 ? new Response(null, { status: 503 }) : echo(request),
      middleware: [
        async (ctx, next) => {
          seen.push(ctx.attempt);
          return next();
        },
      ],
    });
    await api.get("/users/:id", { params: { id: "1" } });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("sees the auth header already set, so it may read or replace it", async () => {
    const seen: (string | null)[] = [];
    const api = createClient<Routes>({
      fetch: echo,
      auth: { token: "t0" },
      middleware: [
        async (ctx, next) => {
          seen.push(ctx.request.headers.get("authorization"));
          return next();
        },
      ],
    });
    await api.get("/users/:id", { params: { id: "1" } });
    expect(seen).toEqual(["Bearer t0"]);
  });

  it("propagates a middleware's throw unchanged, without retrying it", async () => {
    let calls = 0;
    const boom = new Error("boom");
    const api = createClient<Routes>({
      fetch: echo,
      middleware: [
        async () => {
          calls++;
          throw boom;
        },
      ],
    });
    await expect(api.get("/users/:id", { params: { id: "1" } })).rejects.toBe(
      boom,
    );
    expect(calls).toBe(1);
  });
});
