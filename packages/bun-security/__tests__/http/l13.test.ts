/**
 * Layer L13 alone (layers.md L13): `securityHeaders()` as a before-write
 * hook, the CSRF guard's signed double-submit token, and the stack-trace
 * detector behind scrubbing.
 */
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter, ConfigError } from "@kingsleyweb/bun-common";
import type { BeforeWriteContext } from "@kingsleyweb/bun-common";
import { csrf, securityHeaders } from "../../lib/http/index";
import { carriesStack } from "../../lib/http/scrub";

/** A before-write context for a native response, as the adapter gives one. */
function context(
  response: Response,
  url = "http://localhost/x",
): BeforeWriteContext {
  return {
    phase: "response",
    request: new Request(url),
    req: undefined,
    res: undefined,
    response,
  };
}

/** The headers `hook` leaves on `response`. */
function headersAfter(
  hook: ReturnType<typeof securityHeaders>,
  response: Response,
  url?: string,
): Record<string, string> {
  void hook(context(response, url));
  return Object.fromEntries(response.headers);
}

describe("securityHeaders()", () => {
  it("sets the layers.md L13.1 defaults, HSTS only over HTTPS", () => {
    const hook = securityHeaders();
    const plain = headersAfter(hook, new Response("x"));
    expect(plain).toMatchObject({
      "content-security-policy": "frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy":
        "camera=(), microphone=(), geolocation=(), payment=()",
      "x-frame-options": "DENY",
    });
    expect(plain["strict-transport-security"]).toBeUndefined();
    const secure = headersAfter(
      hook,
      new Response("x"),
      "https://example.com/x",
    );
    expect(secure["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(
      headersAfter(
        securityHeaders({
          hsts: { maxAge: 60, includeSubDomains: false, preload: true },
        }),
        new Response("x"),
        "https://example.com/",
      )["strict-transport-security"],
    ).toBe("max-age=60; preload");
  });

  it("keeps the app's own values unless told to override, and leaves out a header set to false", () => {
    const own = () =>
      new Response("x", {
        headers: {
          "content-security-policy": "default-src 'self'",
          "x-powered-by": "Express",
        },
      });
    expect(
      headersAfter(securityHeaders(), own())["content-security-policy"],
    ).toBe("default-src 'self'");
    expect(
      headersAfter(securityHeaders({ override: true }), own())[
        "content-security-policy"
      ],
    ).toBe("frame-ancestors 'none'");
    const trimmed = headersAfter(
      securityHeaders({
        frameOptions: false,
        crossOriginResourcePolicy: "cross-origin",
      }),
      own(),
    );
    expect(trimmed["x-frame-options"]).toBeUndefined();
    expect(trimmed["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(trimmed["x-powered-by"]).toBeUndefined();
  });

  it("marks an answer setting a cookie no-store when it says nothing about caching", () => {
    const withCookie = () =>
      new Response("x", { headers: { "set-cookie": "sid=1" } });
    expect(headersAfter(securityHeaders(), withCookie())["cache-control"]).toBe(
      "no-store",
    );
    const cached = new Response("x", {
      headers: {
        "set-cookie": "sid=1",
        "cache-control": "private, max-age=60",
      },
    });
    expect(headersAfter(securityHeaders(), cached)["cache-control"]).toBe(
      "private, max-age=60",
    );
    expect(
      headersAfter(
        securityHeaders({ noStoreWithCookies: false }),
        withCookie(),
      )["cache-control"],
    ).toBeUndefined();
    expect(
      headersAfter(securityHeaders(), new Response("x"))["cache-control"],
    ).toBeUndefined();
  });

  it("refuses a bad HSTS max-age", () => {
    expect(() => securityHeaders({ hsts: { maxAge: -1 } })).toThrow(RangeError);
  });
});

describe("csrf({ token })", () => {
  const SECRET = "a-secret-of-at-least-thirty-two-bytes!!";

  /** An adapter guarded by a token, with a page issuing it. */
  function guarded(session?: (sid: string | undefined) => string | undefined) {
    const guard = csrf({
      token: {
        secret: SECRET,
        ...(session
          ? {
              session: (req) =>
                session(
                  (req.cookies as Record<string, string | undefined>).sid,
                ),
            }
          : {}),
      },
    });
    const app = new BunHttpAdapter(0, { logger: () => {} });
    app.use(guard);
    app.get("/form", (req, res) => res.send(guard.token(req, res)));
    app.post("/submit", (_req, res) => res.send("ok"));
    return app;
  }

  /** The token and its cookie from a `GET /form`. */
  async function issue(app: BunHttpAdapter, cookie = "sid=1") {
    const page = await app.fetch("/form", { headers: { cookie } });
    const setCookie = page.headers.get("set-cookie") ?? "";
    return {
      token: await page.text(),
      cookie: `${cookie}; ${setCookie.split(";")[0]}`,
    };
  }

  it("issues a token in a cookie and accepts it echoed in a header or a field", async () => {
    const app = guarded();
    const { token, cookie } = await issue(app);
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
    const header = await app.fetch("/submit", {
      method: "POST",
      headers: { cookie, "x-csrf-token": token },
    });
    expect(header.status).toBe(200);
    const field = await app.fetch("/submit", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${encodeURIComponent(token)}`,
    });
    expect(field.status).toBe(200);
  });

  it("refuses a missing, mismatched or forged token", async () => {
    const app = guarded();
    const { token, cookie } = await issue(app);
    const post = (headers: Record<string, string>) =>
      app.fetch("/submit", { method: "POST", headers });
    expect((await post({ cookie })).status).toBe(403);
    expect((await post({ cookie, "x-csrf-token": `${token}x` })).status).toBe(
      403,
    );
    const forged = `${token.split(".")[0] ?? ""}.AAAA`;
    expect(
      (await post({ cookie: `sid=1; csrf=${forged}`, "x-csrf-token": forged }))
        .status,
    ).toBe(403);
    // Without cookies there is nothing to forge: not checked.
    expect((await post({})).status).toBe(200);
  });

  it("binds the token to the session: another session's token is refused", async () => {
    const app = guarded((sid) => sid);
    const { token } = await issue(app, "sid=alice");
    const stolen = await app.fetch("/submit", {
      method: "POST",
      headers: { cookie: `sid=mallory; csrf=${token}`, "x-csrf-token": token },
    });
    expect(stolen.status).toBe(403);
    const own = await app.fetch("/submit", {
      method: "POST",
      headers: { cookie: `sid=alice; csrf=${token}`, "x-csrf-token": token },
    });
    expect(own.status).toBe(200);
  });

  it("keeps a valid token, refuses a short secret, and refuses token() without one", async () => {
    const app = guarded();
    const { token, cookie } = await issue(app);
    const again = await app.fetch("/form", { headers: { cookie } });
    expect([await again.text(), again.headers.get("set-cookie")]).toEqual([
      token,
      null,
    ]);
    expect(() => csrf({ token: { secret: "short" } })).toThrow(ConfigError);
    const bare = csrf();
    const app2 = new BunHttpAdapter(0, { logger: () => {} });
    app2.get("/t", (req, res) => res.send(bare.token(req, res)));
    expect((await app2.fetch("/t")).status).toBe(500);
  });
});

describe("carriesStack()", () => {
  it("finds a stack field or a stack frame, and nothing in ordinary text", () => {
    expect(
      carriesStack(JSON.stringify({ message: "x", stack: "Error: x" })),
    ).toBe(true);
    expect(
      carriesStack("Error: boom\n    at handler (/srv/app.ts:12:5)\n"),
    ).toBe(true);
    expect(carriesStack("Error: boom\n    at /srv/app.ts:12\n")).toBe(true);
    expect(carriesStack("boom\nhandler@/srv/app.ts:12:5\n")).toBe(true);
    expect(carriesStack(JSON.stringify({ message: "meet us at 12:30" }))).toBe(
      false,
    );
    expect(carriesStack("<p>Service unavailable</p>")).toBe(false);
    expect(carriesStack(JSON.stringify({ stacks: 3 }))).toBe(false);
  });
});
