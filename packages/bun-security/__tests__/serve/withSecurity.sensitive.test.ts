/**
 * `withSecurity` on a sign-in handler (layers.md L11): the `profile` option
 * marks the request, the attempted username comes from `identify`, the
 * outcome is inferred from the answer's status, and a success carries the
 * device cookie.
 */
import { describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import { withSecurity } from "../../lib/serve/index";
import { SECRET } from "../sensitive/helpers";

describe("withSecurity on a sign-in handler", () => {
  it("delays after failures inferred from 401s, and sets the device cookie on a 200", async () => {
    const security = createSecurity({
      policy: { profiles: { login: { failures: { delayAfter: 2 } } } },
      secret: SECRET,
      logger: () => {},
      identify: (request) => {
        const username = request.headers.get("x-username");
        return username === null ? undefined : { username };
      },
    });
    const handler = withSecurity(
      security,
      (request) =>
        new Response(null, {
          status: request.headers.get("x-password") === "right" ? 200 : 401,
        }),
      {
        profile: (request) =>
          new URL(request.url).pathname === "/login" ? "login" : undefined,
      },
    );
    const server = { requestIP: () => ({ address: "203.0.113.5" }) };
    const attempt = async (password: string, path = "/login") => {
      const started = performance.now();
      const response = await handler(
        new Request(`http://app.test${path}`, {
          method: "POST",
          headers: { "x-username": "alice", "x-password": password },
        }),
        server,
      );
      return { response, ms: performance.now() - started };
    };
    await attempt("wrong");
    await attempt("wrong");
    expect((await attempt("wrong")).ms).toBeGreaterThanOrEqual(950);
    const ok = await attempt("right");
    expect(ok.response?.status).toBe(200);
    expect(ok.response?.headers.get("set-cookie")).toStartWith(
      "__Host-bun-security-device=",
    );
    // Negative control: another path is not marked, so nothing is counted there.
    for (let i = 0; i < 3; i++) await attempt("wrong", "/other");
    expect((await attempt("wrong", "/other")).ms).toBeLessThan(900);
  });
});
