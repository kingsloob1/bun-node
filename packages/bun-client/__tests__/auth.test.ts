/**
 * Auth (plan §6.1): the token as a bearer header, and the refresh on a 401,
 * **single-flight** — ten concurrent 401s run `refresh()` once and each is
 * sent once more with the new token; a second 401 is returned as it is.
 *
 * The server is a real bun-common router behind `router.fetch()`, accepting
 * only the current token.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { createClient } from "../lib/index";

interface Routes {
  "GET /me/:n": {
    params: { n: string };
    responses: { 200: { n: string; token: string }; 401: { title: string } };
  };
}

/** A server whose valid token can be rotated, counting what it was sent. */
function server(initial: string) {
  const state = { valid: initial, requests: 0, rejected: 0 };
  const router = new BunRouter();
  router.get("/me/:n", async (req, res) => {
    state.requests++;
    await Bun.sleep(5); // the 401s overlap
    const token = req.get("authorization")?.replace(/^Bearer /, "");
    if (token !== state.valid) {
      state.rejected++;
      return res.status(401).json({ title: "Unauthorized" });
    }
    res.json({ n: req.params.n, token });
  });
  return { state, fetch: (request: Request) => router.fetch(request) };
}

describe("the token", () => {
  it("is sent as a bearer header, read per request from a function", async () => {
    const backend = server("t1");
    let current = "t1";
    const api = createClient<Routes>({
      fetch: backend.fetch,
      auth: { token: () => current },
    });
    expect((await api.get("/me/:n", { params: { n: "1" } })).status).toBe(200);
    current = "stale";
    expect((await api.get("/me/:n", { params: { n: "2" } })).status).toBe(401);
  });

  it("gives way to an Authorization header the call sets itself", async () => {
    const backend = server("mine");
    const api = createClient<Routes>({
      fetch: backend.fetch,
      auth: { token: "other" },
    });
    const result = await api.get("/me/:n", {
      params: { n: "1" },
      headers: { authorization: "Bearer mine" },
    });
    expect(result.status).toBe(200);
  });
});

describe("single-flight refresh", () => {
  it("refreshes once for 10 concurrent 401s, and every call succeeds on its retry", async () => {
    const backend = server("old");
    let refreshes = 0;
    const api = createClient<Routes>({
      fetch: backend.fetch,
      auth: {
        token: "expired",
        refresh: async () => {
          refreshes++;
          await Bun.sleep(20);
          backend.state.valid = "fresh";
          return "fresh";
        },
      },
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api.get("/me/:n", { params: { n: String(index) } }),
      ),
    );
    expect(refreshes).toBe(1);
    expect(results.map((result) => result.status)).toEqual(
      Array.from({ length: 10 }, () => 200),
    );
    expect(results.map((result) => result.ok && result.data.token)).toEqual(
      Array.from({ length: 10 }, () => "fresh"),
    );
    // Ten rejected, ten retried with the new token: nothing sent twice more.
    expect(backend.state).toMatchObject({ requests: 20, rejected: 10 });
    // The new token stays for later calls, with no refresh.
    expect((await api.get("/me/:n", { params: { n: "x" } })).status).toBe(200);
    expect(refreshes).toBe(1);
  });

  it("control: the burst really overlaps, so unshared refreshes would run 10 times", async () => {
    // The same burst with a client per call, so no two calls share the
    // single flight: all ten refresh. Proves the test above is not passing
    // because its 401s happened to arrive one after another.
    const backend = server("old");
    let refreshes = 0;
    const refresh = async () => {
      refreshes++;
      await Bun.sleep(20);
      backend.state.valid = "fresh";
      return "fresh";
    };
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        createClient<Routes>({
          fetch: backend.fetch,
          auth: { token: "expired", refresh },
        }).get("/me/:n", {
          params: { n: String(index) },
        }),
      ),
    );
    expect(refreshes).toBe(10);
  });

  it("does not refresh again for a 401 that comes back after the refresh finished", async () => {
    const backend = server("old");
    let refreshes = 0;
    let release!: () => void;
    const late = new Promise<void>((resolve) => (release = resolve));
    const api = createClient<Routes>({
      fetch: async (request) => {
        // The second call's first 401 is held until the refresh is done.
        if (
          request.url.endsWith("/late") &&
          request.headers.get("authorization") === "Bearer expired"
        )
          await late;
        return backend.fetch(request);
      },
      auth: {
        token: "expired",
        refresh: async () => {
          refreshes++;
          backend.state.valid = "fresh";
          return "fresh";
        },
      },
    });
    const late401 = api.get("/me/:n", { params: { n: "late" } });
    const first = await api.get("/me/:n", { params: { n: "early" } });
    release();
    expect(first.status).toBe(200);
    expect((await late401).status).toBe(200);
    expect(refreshes).toBe(1);
  });

  it("returns a second 401 as the result, refreshing only once", async () => {
    const backend = server("never-issued");
    let refreshes = 0;
    const api = createClient<Routes>({
      fetch: backend.fetch,
      auth: { token: "a", refresh: async () => `b${++refreshes}` },
    });
    const result = await api.get("/me/:n", { params: { n: "1" } });
    expect(result.status).toBe(401);
    expect(refreshes).toBe(1);
    expect(backend.state.requests).toBe(2);
  });

  it("returns the 401 untouched when refresh answers null (no new token)", async () => {
    const backend = server("x");
    const api = createClient<Routes>({
      fetch: backend.fetch,
      auth: { token: "a", refresh: async () => null },
    });
    const result = await api.get("/me/:n", { params: { n: "1" } });
    expect(result.status).toBe(401);
    expect(backend.state.requests).toBe(1);
  });

  it("re-reads the token when refresh answers undefined (the app stored it)", async () => {
    const backend = server("x");
    let stored = "a";
    const api = createClient<Routes>({
      fetch: backend.fetch,
      auth: {
        token: () => stored,
        refresh: async () => {
          stored = "x";
          return undefined;
        },
      },
    });
    expect((await api.get("/me/:n", { params: { n: "1" } })).status).toBe(200);
  });

  it("rejects every waiting call with the refresh's error", async () => {
    const backend = server("x");
    const failure = new Error("refresh token expired");
    const api = createClient<Routes>({
      fetch: backend.fetch,
      auth: {
        token: "a",
        refresh: async () => {
          await Bun.sleep(10);
          throw failure;
        },
      },
    });
    const results = await Promise.allSettled(
      [1, 2, 3].map((n) => api.get("/me/:n", { params: { n: String(n) } })),
    );
    expect(
      results.map((result) => result.status === "rejected" && result.reason),
    ).toEqual([failure, failure, failure]);
  });

  it("refreshes on the statuses `on` names", async () => {
    let refreshes = 0;
    const api = createClient<Routes>({
      fetch: async (request) =>
        request.headers.get("authorization") === "Bearer new"
          ? Response.json({ n: "1", token: "new" })
          : new Response(null, { status: 419 }),
      auth: {
        token: "old",
        on: [419],
        refresh: async () => {
          refreshes++;
          return "new";
        },
      },
    });
    expect((await api.get("/me/:n", { params: { n: "1" } })).status).toBe(200);
    expect(refreshes).toBe(1);
  });
});
