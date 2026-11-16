/**
 * `./serve`'s `withSecurity` with PR-S2's layers on a real `Bun.serve`
 * (port 0): a `429` with `Retry-After` and problem+json from a limit, the
 * per-address in-flight limit over a slow handler (each request tracked and
 * completed), the in-flight cap's `503`, and outcomes (a thrown handler is a
 * `500`) feeding counted rules.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import type { SecurityPolicy } from "../../lib/index";
import { withSecurity } from "../../lib/serve/index";

/** Servers to stop after the file. */
const servers: Bun.Server<undefined>[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
});

/** Serves `handler` behind the engine on port 0. */
function serve(
  policy: SecurityPolicy,
  handler: (request: Request) => Response | Promise<Response>,
) {
  const security = createSecurity<Request>({ policy, logger: () => {} });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: withSecurity(security, handler, { logger: () => {} }),
    // A thrown handler answers 500 here, as an app's own error page would.
    error: () => new Response("internal error", { status: 500 }),
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, security };
}

describe("withSecurity with limits", () => {
  it("answers a limit's refusal 429 with Retry-After and problem+json naming no rule", async () => {
    const { url } = serve(
      {
        internal: false,
        limits: [
          { id: "tight", limit: 2, window: "1m", algorithm: "fixed-window" },
        ],
      },
      () => new Response("ok"),
    );
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 3; i++) {
      last = await fetch(url);
      statuses.push(last.status);
      if (i < 2) await last.text();
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(last?.headers.get("content-type")).toBe("application/problem+json");
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    const body = await last?.text();
    expect(JSON.parse(body ?? "{}")).toEqual({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      code: "rate_limited",
    });
    expect(body).not.toContain("tight");
  });

  it("limits requests in flight per address over a slow handler, and frees each on completion", async () => {
    const gates: (() => void)[] = [];
    const { url, security } = serve(
      { internal: false, concurrency: { perIp: 2 } },
      () =>
        new Promise<Response>((resolve) => {
          gates.push(() => resolve(new Response("slow")));
        }),
    );
    const first = fetch(url);
    const second = fetch(url);
    while (gates.length < 2) await Bun.sleep(5);
    const third = await fetch(url);
    expect(third.status).toBe(429);
    expect(security.status().state.inFlight).toBe(2);
    for (const open of gates.splice(0)) open();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(security.status().state.inFlight).toBe(0);
    const fourth = fetch(url);
    while (gates.length < 1) await Bun.sleep(5);
    gates.splice(0)[0]?.();
    expect((await fourth).status).toBe(200);
  });

  it("sheds load past the in-flight cap with 503", async () => {
    const gates: (() => void)[] = [];
    const { url } = serve(
      { concurrency: { perIp: false, total: 1 } },
      () =>
        new Promise<Response>((resolve) => {
          gates.push(() => resolve(new Response("slow")));
        }),
    );
    const held = fetch(url);
    while (gates.length < 1) await Bun.sleep(5);
    const shed = await fetch(url);
    expect(shed.status).toBe(503);
    expect(shed.headers.get("retry-after")).toBe("1");
    gates.splice(0)[0]?.();
    expect((await held).status).toBe(200);
  });

  it("reports a thrown handler as a 500, which a counted rule on server.error counts", async () => {
    const { url } = serve(
      {
        internal: false,
        bans: { retryAfter: true },
        countedRules: [
          {
            id: "crashes",
            event: "server.error",
            threshold: 2,
            window: "1m",
            duration: "1h",
          },
        ],
      },
      (request) => {
        if (new URL(request.url).pathname === "/boom") throw new Error("boom");
        return new Response("ok");
      },
    );
    expect((await fetch(`${url}/boom`)).status).toBe(500);
    expect((await fetch(`${url}/ok`)).status).toBe(200);
    expect((await fetch(`${url}/boom`)).status).toBe(500);
    const banned = await fetch(`${url}/ok`);
    expect(banned.status).toBe(403);
    expect(banned.headers.get("retry-after")).toBe("3600");
  });
});
