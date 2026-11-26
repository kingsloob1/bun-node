/**
 * `mountAuth` with a real better-auth on bun-common's adapter, under the
 * three body configurations that matter (plan §4.1, evidence E5 and E14):
 * the default (bytes kept), `deferBody` (the body unread) and
 * `retainBuffer: false` (read without its bytes, handed over as `"parsed"`).
 * Each signs up, signs in with JSON and with a form, and reaches a route
 * behind `requireSession` with the cookie.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import type { AuthRequest } from "../lib";
import { authHandler, getAuthSession, mountAuth, requireSession } from "../lib";
import type { AppAuth } from "./helpers";
import {
  cookieOf,
  formPost,
  jsonPost,
  makeAuth,
  nextEmail,
  ORIGIN,
  PASSWORD,
  warningsIn,
} from "./helpers";

// Every case signs up or in through better-auth, whose scrypt hashing is
// CPU-bound: on a loaded machine one case outlasted bun:test's 5 s (seed
// 797066127 at a load of 161).
setDefaultTimeout(30_000);

/** The adapter's body options for each configuration under test. */
const CONFIGS = [
  { name: "default adapter", request: {}, parsed: false },
  { name: "deferBody", request: { deferBody: true }, parsed: false },
  {
    name: "retainBuffer: false",
    request: { retainBuffer: false },
    parsed: true,
  },
] as const;

/** An adapter with better-auth mounted and a guarded `/me`. */
function appFor(request: Record<string, boolean>) {
  const { logger, events } = createTestLogger();
  const auth = makeAuth();
  const app = new BunHttpAdapter(0, { logger, request });
  mountAuth(app, auth);
  app.get(
    "/me",
    requireSession(auth),
    (req: AuthRequest<AppAuth>, res: BunResponse) => {
      const again = getAuthSession<AppAuth>(req);
      res.json({
        email: req.user?.email ?? null,
        // Typed from the instance: the admin plugin's role.
        role: req.user?.role ?? null,
        sameAsGetter: again?.user.id === req.user?.id,
        sessionUser: req.session?.userId === req.user?.id,
      });
    },
  );
  return { app, auth, events };
}

describe.each([...CONFIGS])("mountAuth on the $name", (config) => {
  it("signs up, signs in with JSON and with a form, and reaches requireSession's route", async () => {
    const { app, events } = appFor(config.request);
    const email = nextEmail();

    const up = await app.fetch(
      `${ORIGIN}/api/auth/sign-up/email`,
      jsonPost({ email, password: PASSWORD, name: "Ann" }),
    );
    expect(up.status).toBe(200);
    expect(cookieOf(up)).toContain("better-auth.session_token=");

    const signIn = await app.fetch(
      `${ORIGIN}/api/auth/sign-in/email`,
      jsonPost({ email, password: PASSWORD }),
    );
    expect(signIn.status).toBe(200);
    const cookie = cookieOf(signIn);
    const setCookie = signIn.headers.getSetCookie()[0] ?? "";
    expect(setCookie).toContain("HttpOnly");

    const form = await app.fetch(
      `${ORIGIN}/api/auth/sign-in/email`,
      formPost({ email, password: PASSWORD }),
    );
    expect(form.status).toBe(200);

    const anonymous = await app.fetch(`${ORIGIN}/me`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await anonymous.json()).toEqual({
      type: "urn:bun-auth:error:UNAUTHORIZED",
      title: "Unauthorized",
      status: 401,
      code: "UNAUTHORIZED",
      detail: "A session is required.",
    });

    const me = await app.fetch(`${ORIGIN}/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      email,
      role: "user",
      sameAsGetter: true,
      sessionUser: true,
    });

    // better-auth's own session route through the mount.
    const session = await app.fetch(`${ORIGIN}/api/auth/get-session`, {
      headers: { cookie },
    });
    expect(
      ((await session.json()) as { user: { email: string } }).user.email,
    ).toBe(email);

    // Signing out answers several Set-Cookies, all kept.
    const out = await app.fetch(
      `${ORIGIN}/api/auth/sign-out`,
      jsonPost({}, { cookie }),
    );
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().length).toBeGreaterThanOrEqual(1);
    const after = await app.fetch(`${ORIGIN}/me`, { headers: { cookie } });
    expect(after.status).toBe(401);

    // The body warning is logged for retainBuffer: false alone, once.
    expect(warningsIn(events).filter((kind) => kind === "body-bytes")).toEqual(
      config.parsed ? ["body-bytes"] : [],
    );
  });
});

describe("the body hand-over", () => {
  it("negative control: handing better-auth req.request fails on the default adapter (E5)", async () => {
    const auth = makeAuth();
    const app = new BunHttpAdapter(0, { logger: () => {} });
    app.use("/api/auth", async (req: BunRequest, res: BunResponse) => {
      try {
        res.send(await auth.handler(req.request));
      } catch {
        res.status(500).send("Body already used");
      }
    });
    const up = await app.fetch(
      `${ORIGIN}/api/auth/sign-up/email`,
      jsonPost({ email: nextEmail(), password: PASSWORD, name: "Ann" }),
    );
    expect(up.status).toBe(500);
  });

  it("warns about the body at mount when the adapter drops bytes without deferBody, and not with deferBody", () => {
    for (const [request, expected] of [
      [{ retainBuffer: false }, ["body-bytes"]],
      [{ retainBuffer: false, deferBody: true }, []],
      [{}, []],
    ] as const) {
      const { logger, events } = createTestLogger();
      mountAuth(new BunHttpAdapter(0, { logger, request }), makeAuth());
      expect(warningsIn(events)).toEqual([...expected]);
    }
  });

  it("answers a route outside the base path with the app's own handlers", async () => {
    const { app } = appFor({});
    app.get("/api/other", (_req: BunRequest, res: BunResponse) => {
      res.send("app");
    });
    const other = await app.fetch(`${ORIGIN}/api/other`);
    expect(await other.text()).toBe("app");
    const unknown = await app.fetch(`${ORIGIN}/api/auth/no-such-route`);
    expect(unknown.status).toBe(404);
  });

  it("mounts under options.basePath on a sub-router", async () => {
    const { logger } = createTestLogger();
    const auth = makeAuth();
    const app = new BunHttpAdapter(0, { logger });
    // The instance answers under /api/auth; the router sees the path as is.
    mountAuth(app, auth, { basePath: "/api/auth/" });
    const ok = await app.fetch(`${ORIGIN}/api/auth/ok`);
    expect(ok.status).toBe(200);
  });
});

describe("the app's configuration", () => {
  it("is read and never changed", async () => {
    const auth = makeAuth();
    const snapshot = JSON.stringify(auth.options);
    const advanced = auth.options.advanced;
    const { logger } = createTestLogger();
    const app = new BunHttpAdapter(0, { logger });
    mountAuth(app, auth);
    await app.fetch(
      `${ORIGIN}/api/auth/sign-up/email`,
      jsonPost({ email: nextEmail(), password: PASSWORD, name: "Ann" }),
    );
    expect(JSON.stringify(auth.options)).toBe(snapshot);
    expect(auth.options.advanced).toBe(advanced);
  });
});

describe("authHandler on its own", () => {
  it("warns about a parsed body at its first request, once, where it cannot see the adapter", async () => {
    const { logger, events } = createTestLogger();
    const auth = makeAuth();
    const app = new BunHttpAdapter(0, {
      logger,
      request: { retainBuffer: false },
    });
    app.use("/api/auth", authHandler(auth, { logger }));
    expect(warningsIn(events)).toEqual([]);
    for (let i = 0; i < 2; i++) {
      const up = await app.fetch(
        `${ORIGIN}/api/auth/sign-up/email`,
        jsonPost({ email: nextEmail(), password: PASSWORD, name: "Ann" }),
      );
      expect(up.status).toBe(200);
    }
    expect(warningsIn(events)).toEqual(["body-bytes"]);
  });

  it("negative control: no body warning when the bytes are kept", async () => {
    const { logger, events } = createTestLogger();
    const app = new BunHttpAdapter(0, { logger });
    app.use("/api/auth", authHandler(makeAuth(), { logger }));
    const up = await app.fetch(
      `${ORIGIN}/api/auth/sign-up/email`,
      jsonPost({ email: nextEmail(), password: PASSWORD, name: "Ann" }),
    );
    expect(up.status).toBe(200);
    expect(warningsIn(events)).toEqual([]);
  });
});
