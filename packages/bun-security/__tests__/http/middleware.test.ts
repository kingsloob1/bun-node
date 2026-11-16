/**
 * `securityMiddleware()` on its own (PR-S5): the route stage for a router
 * `installSecurity` does not cover, evaluating every stage at once.
 */
import { describe, expect, it } from "bun:test";
import { BunRouter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "../../lib/index";
import type { SecurityPolicy } from "../../lib/index";
import { requestSecurity, securityMiddleware } from "../../lib/http/index";

/** A router guarded by the middleware, with the router passed or not. */
function guarded(policy: SecurityPolicy, withRouter = true) {
  const security = createSecurity<BunRequest>({
    policy,
    logger: () => {},
    identify: (req) => {
      const user = req.request.headers.get("x-user");
      return user === null ? undefined : { user };
    },
  });
  const router = new BunRouter();
  router.use(
    securityMiddleware(security, {
      logger: () => {},
      ...(withRouter ? { router } : {}),
    }),
  );
  return { router, security };
}

const from = (client: string, init: Record<string, unknown> = {}) => ({
  remoteAddress: client,
  ...init,
});

describe("securityMiddleware()", () => {
  it("evaluates every stage at once: address and caller limits, the lists", async () => {
    const { router } = guarded({
      lists: [{ ip: "203.0.113.66", action: "block" }],
      limits: [
        { id: "ip", limit: 2, window: "1m" },
        { id: "user", limit: 1, window: "1m", key: "user" },
      ],
    });
    router.get("/x", (_req, res) => res.send("x"));
    expect((await router.fetch("/x", from("203.0.113.66"))).status).toBe(403);
    expect((await router.fetch("/x", from("198.51.100.1"))).status).toBe(200);
    expect((await router.fetch("/x", from("198.51.100.1"))).status).toBe(200);
    expect((await router.fetch("/x", from("198.51.100.1"))).status).toBe(429);
    const as = from("198.51.100.2", { headers: { "x-user": "u" } });
    expect((await router.fetch("/x", as)).status).toBe(200);
    expect((await router.fetch("/x", as)).status).toBe(429);
  });

  it("knows the route with the router passed, and counts a not-found middleware's answer", async () => {
    const { router } = guarded({
      limits: [{ id: "page", limit: 1, window: "1m", routes: ["GET /p/:id"] }],
      countedRules: [
        {
          id: "nf",
          event: "route.notFound",
          threshold: 2,
          window: "1m",
          duration: "1h",
        },
      ],
    });
    let routeKey: string | undefined;
    router.get("/p/:id", (req, res) => {
      routeKey = requestSecurity(req)?.facts?.routeKey;
      res.send("p");
    });
    // On its own the middleware sees only answers sent on the response: a
    // not-found middleware's, not a bare router's built-in 404.
    router.use((_req, res) => res.status(404).send("not found"));
    expect((await router.fetch("/p/1", from("198.51.100.3"))).status).toBe(200);
    expect(routeKey).toBe("GET /p/:id");
    expect((await router.fetch("/p/2", from("198.51.100.3"))).status).toBe(429);
    expect((await router.fetch("/nope", from("198.51.100.4"))).status).toBe(
      404,
    );
    expect((await router.fetch("/nope", from("198.51.100.4"))).status).toBe(
      404,
    );
    await Bun.sleep(5);
    expect((await router.fetch("/p/9", from("198.51.100.4"))).status).toBe(403);
  });

  it("without the router, applies no route pattern and counts no route-not-found", async () => {
    const { router } = guarded(
      {
        limits: [
          { id: "page", limit: 1, window: "1m", routes: ["GET /p/:id"] },
        ],
        countedRules: [
          {
            id: "nf",
            event: "route.notFound",
            threshold: 1,
            window: "1m",
            duration: "1h",
          },
        ],
      },
      false,
    );
    router.get("/p/:id", (_req, res) => res.send("p"));
    expect((await router.fetch("/p/1", from("198.51.100.5"))).status).toBe(200);
    expect((await router.fetch("/p/2", from("198.51.100.5"))).status).toBe(200);
    expect((await router.fetch("/nope", from("198.51.100.5"))).status).toBe(
      404,
    );
    expect((await router.fetch("/p/3", from("198.51.100.5"))).status).toBe(200);
  });

  it("takes no in-flight slot: only installSecurity's early hook does", async () => {
    const { router, security } = guarded({ concurrency: { perIp: 1 } });
    router.get("/x", (_req, res) => res.send("x"));
    expect((await router.fetch("/x", from("198.51.100.6"))).status).toBe(200);
    expect(security.status().state.inFlight).toBe(0);
  });
});
