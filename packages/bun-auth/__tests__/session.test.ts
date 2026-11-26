/**
 * The session on the request (plan §5): `sessionMiddleware`, `requireSession`
 * with roles and an organization, `getAuthSession`, one lookup per request.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { BunHttpAdapter, ConfigError } from "@kingsleyweb/bun-common";
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import type { AuthRequest, AuthSession } from "../lib";
import {
  getAuthSession,
  mountAuth,
  requireSession,
  sessionMiddleware,
} from "../lib";
import type { AppAuth } from "./helpers";
import {
  cookieOf,
  jsonPost,
  makeAuth,
  nextEmail,
  ORIGIN,
  PASSWORD,
} from "./helpers";

// Every case signs up or in through better-auth, whose scrypt hashing is
// CPU-bound: on a loaded machine one case outlasted bun:test's 5 s (seed
// 797066127 at a load of 161).
setDefaultTimeout(30_000);

/** An app with better-auth mounted, and a signed-up user's cookie. */
async function signedIn() {
  const auth = makeAuth();
  const app = new BunHttpAdapter(0, { logger: () => {} });
  mountAuth(app, auth, { warn: false });
  const email = nextEmail();
  const up = await app.fetch(
    `${ORIGIN}/api/auth/sign-up/email`,
    jsonPost({ email, password: PASSWORD, name: "Ann" }),
  );
  expect(up.status).toBe(200);
  const cookie = cookieOf(up);
  const found = await auth.api.getSession({ headers: new Headers({ cookie }) });
  return { auth, app, cookie, email, userId: found?.user.id ?? "" };
}

/** Counts `getSession` calls on `auth`, without changing what it answers. */
function countLookups(auth: AppAuth): { count: number } {
  const counter = { count: 0 };
  const original = auth.api.getSession.bind(auth.api);
  (auth.api as { getSession: unknown }).getSession = (
    ...args: Parameters<typeof original>
  ) => {
    counter.count += 1;
    return original(...args);
  };
  return counter;
}

describe("sessionMiddleware", () => {
  it("sets req.session and req.user, or null for each, and never refuses", async () => {
    const { auth, app, cookie, email } = await signedIn();
    app.get(
      "/who",
      sessionMiddleware(auth),
      (req: AuthRequest<AppAuth>, res: BunResponse) => {
        res.json({
          email: req.user === null ? null : req.user?.email,
          session: req.session === null ? null : typeof req.session?.id,
        });
      },
    );
    const anonymous = await app.fetch(`${ORIGIN}/who`);
    expect(await anonymous.json()).toEqual({ email: null, session: null });
    const known = await app.fetch(`${ORIGIN}/who`, { headers: { cookie } });
    expect(await known.json()).toEqual({ email, session: "string" });
  });

  it("looks the session up once per request, however many readers there are", async () => {
    const { auth, app, cookie } = await signedIn();
    const lookups = countLookups(auth);
    app.get(
      "/twice",
      sessionMiddleware(auth),
      sessionMiddleware(auth),
      requireSession(auth),
      (req: BunRequest, res: BunResponse) => {
        res.json({ id: getAuthSession<AppAuth>(req)?.user.id });
      },
    );
    const response = await app.fetch(`${ORIGIN}/twice`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    expect(lookups.count).toBe(1);
    // A second request looks it up again.
    await app.fetch(`${ORIGIN}/twice`, { headers: { cookie } });
    expect(lookups.count).toBe(2);
  });

  it("reads a bearer session as better-auth resolves it (the headers are passed whole)", async () => {
    const { auth, app, cookie } = await signedIn();
    const seen: Headers[] = [];
    const original = auth.api.getSession.bind(auth.api);
    (auth.api as { getSession: unknown }).getSession = (context: {
      headers: Headers;
    }) => {
      seen.push(context.headers);
      return original(context);
    };
    app.get(
      "/h",
      sessionMiddleware(auth),
      (_req: BunRequest, res: BunResponse) => {
        res.send("ok");
      },
    );
    await app.fetch(`${ORIGIN}/h`, {
      headers: { cookie, authorization: "Bearer t" },
    });
    expect(seen[0]?.get("authorization")).toBe("Bearer t");
    expect(seen[0]?.get("cookie")).toBe(cookie);
  });
});

describe("getAuthSession", () => {
  it("throws when nothing looked the session up, rather than answer null", async () => {
    const { app } = await signedIn();
    let thrown: unknown;
    app.get("/none", (req: BunRequest, res: BunResponse) => {
      try {
        getAuthSession(req);
      } catch (error) {
        thrown = error;
      }
      res.send("ok");
    });
    await app.fetch(`${ORIGIN}/none`);
    expect(thrown).toBeInstanceOf(TypeError);
  });

  it("is typed from the instance", async () => {
    const { auth, app, cookie } = await signedIn();
    let found: AuthSession<AppAuth> | null = null;
    app.get(
      "/t",
      sessionMiddleware(auth),
      (req: BunRequest, res: BunResponse) => {
        found = getAuthSession<AppAuth>(req);
        // The admin plugin's fields, typed: no cast.
        const role: string | null | undefined = found?.user.role;
        const banned: boolean | null | undefined = found?.user.banned;
        res.json({ role, banned });
      },
    );
    const response = await app.fetch(`${ORIGIN}/t`, { headers: { cookie } });
    expect(await response.json()).toEqual({ role: "user", banned: false });
    expect(found).not.toBeNull();
  });

  it("reads by the native request as well", async () => {
    const { auth, app, cookie, userId } = await signedIn();
    let id: string | undefined;
    app.get(
      "/n",
      sessionMiddleware(auth),
      (req: BunRequest, res: BunResponse) => {
        id = getAuthSession<AppAuth>(req.request)?.user.id;
        res.send("ok");
      },
    );
    await app.fetch(`${ORIGIN}/n`, { headers: { cookie } });
    expect(id).toBe(userId);
  });
});

describe("requireSession", () => {
  it("answers 403 without one of the roles, 200 with it, and reads a comma-separated role", async () => {
    const { auth, app, cookie, userId } = await signedIn();
    app.get(
      "/admin",
      requireSession(auth, { roles: ["admin"] }),
      (_req: BunRequest, res: BunResponse) => {
        res.send("admin");
      },
    );
    const refused = await app.fetch(`${ORIGIN}/admin`, { headers: { cookie } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { type: string }).type).toBe(
      "urn:bun-auth:error:FORBIDDEN",
    );
    const ctx = await auth.$context;
    await ctx.internalAdapter.updateUser(userId, { role: "user,admin" });
    const allowed = await app.fetch(`${ORIGIN}/admin`, { headers: { cookie } });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("admin");
  });

  it("answers 403 without the active organization, 200 once it is active", async () => {
    const { auth, app, cookie } = await signedIn();
    app.get(
      "/org",
      requireSession(auth, { organization: true }),
      (_req: BunRequest, res: BunResponse) => {
        res.send("org");
      },
    );
    expect(
      (await app.fetch(`${ORIGIN}/org`, { headers: { cookie } })).status,
    ).toBe(403);
    const headers = new Headers({ cookie });
    const org = await auth.api.createOrganization({
      headers,
      body: { name: "Acme", slug: `acme-${crypto.randomUUID().slice(0, 8)}` },
    });
    await auth.api.setActiveOrganization({
      headers,
      body: { organizationId: org?.id ?? "" },
    });
    expect(
      (await app.fetch(`${ORIGIN}/org`, { headers: { cookie } })).status,
    ).toBe(200);
    app.get(
      "/other-org",
      requireSession(auth, { organization: "not-this-one" }),
      (_req: BunRequest, res: BunResponse) => {
        res.send("never");
      },
    );
    expect(
      (await app.fetch(`${ORIGIN}/other-org`, { headers: { cookie } })).status,
    ).toBe(403);
    app.get(
      "/this-org",
      requireSession(auth, { organization: org?.id ?? "" }),
      (_req: BunRequest, res: BunResponse) => {
        res.send("ok");
      },
    );
    expect(
      (await app.fetch(`${ORIGIN}/this-org`, { headers: { cookie } })).status,
    ).toBe(200);
  });

  it("refuses invalid options at creation", () => {
    const auth = makeAuth();
    for (const options of [
      { roles: [] },
      { roles: [""] },
      { roles: "admin" },
      { organization: "" },
      { organization: false },
    ]) {
      expect(() =>
        requireSession(auth, options as Parameters<typeof requireSession>[1]),
      ).toThrow(ConfigError);
    }
    expect(() => requireSession({} as AppAuth)).toThrow(ConfigError);
  });
});
