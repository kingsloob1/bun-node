/**
 * `withAuth` (`./serve`) on a plain `Bun.serve`, served on port 0: better-auth
 * answers under its base path, the app's `fetch` everything else, and the
 * client-address header is the socket peer.
 */
import { createTestLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { DEFAULT_CLIENT_IP_HEADER } from "../lib";
import { withAuth } from "../lib/serve";
import {
  cookieOf,
  jsonPost,
  makePlainAuth,
  nextEmail,
  PASSWORD,
  warningsIn,
} from "./helpers";

// Every case signs up or in through better-auth, whose scrypt hashing is
// CPU-bound: on a loaded machine one case outlasted bun:test's 5 s (seed
// 797066127 at a load of 161).
setDefaultTimeout(30_000);

const auth = makePlainAuth();
const { logger, events } = createTestLogger();
const server = Bun.serve({
  port: 0,
  fetch: withAuth(
    auth,
    async (request) => {
      const found = await auth.api.getSession({ headers: request.headers });
      return Response.json({
        path: new URL(request.url).pathname,
        email: found?.user.email ?? null,
        header: request.headers.get(DEFAULT_CLIENT_IP_HEADER),
      });
    },
    { logger },
  ),
});
afterAll(() => server.stop(true));

/** The served URL of `path`. */
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

/** `jsonPost` with the served origin, which better-auth checks against its own. */
const post = (body: unknown, headers: Record<string, string> = {}) =>
  jsonPost(body, { origin: "http://localhost", ...headers });

describe("withAuth on Bun.serve", () => {
  it("signs up and in through better-auth, and hands every other path to the app", async () => {
    const email = nextEmail();
    const up = await fetch(
      url("/api/auth/sign-up/email"),
      post({ email, password: PASSWORD, name: "Ann" }),
    );
    expect(up.status).toBe(200);
    const signIn = await fetch(
      url("/api/auth/sign-in/email"),
      post({ email, password: PASSWORD }),
    );
    expect(signIn.status).toBe(200);
    const cookie = cookieOf(signIn);
    const app = await fetch(url("/me"), { headers: { cookie } });
    expect(await app.json()).toEqual({
      path: "/me",
      email,
      // The app's own requests are passed on as they came.
      header: null,
    });
    // A path that only starts with the base path's text is the app's.
    const near = await fetch(url("/api/authx"));
    expect(((await near.json()) as { path: string }).path).toBe("/api/authx");
    const session = await fetch(url("/api/auth/get-session"), {
      headers: { cookie },
    });
    expect(
      ((await session.json()) as { user: { email: string } }).user.email,
    ).toBe(email);
  });

  it("stores the socket peer as the session's address, not a forged header", async () => {
    const up = await fetch(
      url("/api/auth/sign-up/email"),
      post(
        { email: nextEmail(), password: PASSWORD, name: "Ann" },
        {
          "x-forwarded-for": "203.0.113.66",
          [DEFAULT_CLIENT_IP_HEADER]: "203.0.113.77",
        },
      ),
    );
    const found = await auth.api.getSession({
      headers: new Headers({ cookie: cookieOf(up) }),
    });
    expect(found?.session.ipAddress).toBe("127.0.0.1");
  });

  it("logs no warning for the recommended configuration", () => {
    expect(warningsIn(events)).toEqual([]);
  });

  it("warns at creation for a configuration that hides errors", () => {
    const own = createTestLogger();
    withAuth(makePlainAuth({ onAPIError: {} }), () => new Response(), {
      logger: own.logger,
    });
    expect(warningsIn(own.events)).toEqual(["error-handling"]);
  });

  it("rejects with better-auth's error under onAPIError.throw, for Bun.serve's error()", async () => {
    const failing = { on: false };
    const broken = makePlainAuth({}, failing);
    const handle = withAuth(broken, () => new Response("app"), {
      logger: createTestLogger().logger,
    });
    failing.on = true;
    const stub = { requestIP: () => ({ address: "198.51.100.1" }) };
    let thrown: unknown;
    try {
      await handle(
        new Request(
          "http://localhost/api/auth/sign-in/email",
          post({ email: "ann@example.test", password: PASSWORD }),
        ),
        stub,
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe("db connection lost");
  });

  it("refuses a fetch that is not a function", () => {
    expect(() =>
      withAuth(auth, undefined as unknown as () => Response),
    ).toThrow(TypeError);
  });
});
