/**
 * The client's address (plan §4.2, evidence E15): bun-auth sets
 * `x-bun-auth-client-ip` from bun-common's `req.clientAddress`, removing any
 * copy the client sent, and better-auth reads it once the app names it in
 * `advanced.ipAddress.ipAddressHeaders`: in the session's `ipAddress` and in
 * its rate limiter.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import type { BetterAuthAdvancedOptions } from "better-auth";
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { DEFAULT_CLIENT_IP_HEADER, mountAuth } from "../lib";
import {
  cookieOf,
  jsonPost,
  makePlainAuth,
  nextEmail,
  ORIGIN,
  PASSWORD,
  warningsIn,
} from "./helpers";

// Every case signs up or in through better-auth, whose scrypt hashing is
// CPU-bound: on a loaded machine one case outlasted bun:test's 5 s (seed
// 797066127 at a load of 161).
setDefaultTimeout(30_000);

type Auth = ReturnType<typeof makePlainAuth>;

/** Signs up through `app` and answers the address better-auth stored on the session. */
async function sessionAddress(
  app: BunHttpAdapter,
  auth: Auth,
  init: { remoteAddress: string; headers?: Record<string, string> },
): Promise<string | null | undefined> {
  const up = await app.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    ...jsonPost(
      { email: nextEmail(), password: PASSWORD, name: "Ann" },
      init.headers,
    ),
    remoteAddress: init.remoteAddress,
  });
  expect(up.status).toBe(200);
  const found = await auth.api.getSession({
    headers: new Headers({ cookie: cookieOf(up) }),
  });
  return found?.session.ipAddress;
}

describe("the client-address header", () => {
  it("carries the socket peer, not a forged X-Forwarded-For or a forged copy of the header", async () => {
    const auth = makePlainAuth();
    const app = new BunHttpAdapter(0, { logger: () => {} });
    mountAuth(app, auth);
    expect(
      await sessionAddress(app, auth, {
        remoteAddress: "198.51.100.4",
        headers: {
          "x-forwarded-for": "203.0.113.66",
          [DEFAULT_CLIENT_IP_HEADER]: "203.0.113.77",
        },
      }),
    ).toBe("198.51.100.4");
  });

  it("carries the client bun-common resolved through trustProxy", async () => {
    const auth = makePlainAuth();
    const app = new BunHttpAdapter(0, {
      logger: () => {},
      trustProxy: "loopback",
    });
    mountAuth(app, auth);
    expect(
      await sessionAddress(app, auth, {
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": "203.0.113.9" },
      }),
    ).toBe("203.0.113.9");
    // An IPv4-mapped peer arrives normalised.
    expect(
      await sessionAddress(app, auth, { remoteAddress: "::ffff:198.51.100.7" }),
    ).toBe("198.51.100.7");
  });

  it("is what reaches better-auth's handler: one value, the client's copy gone", async () => {
    const auth = makePlainAuth();
    const seen: Array<string | null> = [];
    const spy = {
      ...auth,
      handler: async (request: Request) => {
        seen.push(request.headers.get(DEFAULT_CLIENT_IP_HEADER));
        return new Response("ok");
      },
    };
    const app = new BunHttpAdapter(0, { logger: () => {} });
    mountAuth(app, spy);
    await app.fetch(`${ORIGIN}/api/auth/x`, {
      remoteAddress: "198.51.100.4",
      headers: { [DEFAULT_CLIENT_IP_HEADER]: "203.0.113.77" },
    });
    // No peer (socket-free, none named): the forged copy is removed, nothing set.
    await app.fetch(`${ORIGIN}/api/auth/x`, {
      headers: { [DEFAULT_CLIENT_IP_HEADER]: "203.0.113.77" },
    });
    expect(seen).toEqual(["198.51.100.4", null]);
  });

  it("follows clientIpHeader", async () => {
    const auth = makePlainAuth({
      advanced: { ipAddress: { ipAddressHeaders: ["x-client"] } },
    });
    const { logger, events } = createTestLogger();
    const app = new BunHttpAdapter(0, { logger });
    mountAuth(app, auth, { clientIpHeader: "X-Client" });
    expect(warningsIn(events)).not.toContain("client-address");
    expect(
      await sessionAddress(app, auth, {
        remoteAddress: "198.51.100.5",
        headers: { "x-client": "203.0.113.1" },
      }),
    ).toBe("198.51.100.5");
  });

  it("negative control: without ipAddressHeaders better-auth stores the forged X-Forwarded-For, and bun-auth warns", async () => {
    const auth = makePlainAuth({ advanced: {} });
    const { logger, events } = createTestLogger();
    const app = new BunHttpAdapter(0, { logger });
    mountAuth(app, auth);
    expect(warningsIn(events)).toContain("client-address");
    expect(
      await sessionAddress(app, auth, {
        remoteAddress: "198.51.100.4",
        headers: { "x-forwarded-for": "203.0.113.66" },
      }),
    ).toBe("203.0.113.66");
  });
});

describe("better-auth's limiter, keyed on the header", () => {
  /** Six wrong sign-ins from one peer, each with a new forged X-Forwarded-For. */
  async function statuses(auth: Auth): Promise<number[]> {
    const app = new BunHttpAdapter(0, { logger: () => {} });
    mountAuth(app, auth, { warn: false });
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await app.fetch(`${ORIGIN}/api/auth/sign-in/email`, {
        ...jsonPost(
          { email: "nobody@example.test", password: "wrong-password" },
          { "x-forwarded-for": `203.0.113.${i + 1}` },
        ),
        remoteAddress: "198.51.100.4",
      });
      seen.push(response.status);
    }
    return seen;
  }

  const limits = {
    enabled: true,
    storage: "database",
    customRules: { "/sign-in/email": { window: 60, max: 3 } },
  } as const;

  it("counts one client however its X-Forwarded-For changes", async () => {
    expect(await statuses(makePlainAuth({ rateLimit: limits }))).toEqual([
      401, 401, 401, 429, 429, 429,
    ]);
  });

  it("negative control: on X-Forwarded-For (better-auth's default) it never limits", async () => {
    expect(
      await statuses(makePlainAuth({ rateLimit: limits, advanced: {} })),
    ).toEqual([401, 401, 401, 401, 401, 401]);
  });
});

describe("the client-address warning", () => {
  const cases: Array<[string, BetterAuthAdvancedOptions, boolean]> = [
    ["unset (x-forwarded-for)", {}, true],
    [
      "only the header",
      { ipAddress: { ipAddressHeaders: [DEFAULT_CLIENT_IP_HEADER] } },
      false,
    ],
    [
      "the header in another case",
      { ipAddress: { ipAddressHeaders: ["X-Bun-Auth-Client-IP"] } },
      false,
    ],
    [
      "the header and x-forwarded-for",
      {
        ipAddress: {
          ipAddressHeaders: [DEFAULT_CLIENT_IP_HEADER, "x-forwarded-for"],
        },
      },
      true,
    ],
    [
      "another header",
      { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
      true,
    ],
    ["ip tracking disabled", { ipAddress: { disableIpTracking: true } }, false],
  ];
  for (const [name, advanced, warns] of cases) {
    it(`${warns ? "warns" : "is quiet"} with ipAddressHeaders ${name}`, () => {
      const { logger, events } = createTestLogger();
      const app = new BunHttpAdapter(0, { logger });
      mountAuth(app, makePlainAuth({ advanced }));
      expect(warningsIn(events).includes("client-address")).toBe(warns);
    });
  }

  it("is not logged with warn: false", () => {
    const { logger, events } = createTestLogger();
    const app = new BunHttpAdapter(0, { logger });
    mountAuth(app, makePlainAuth({ advanced: {}, onAPIError: {} }), {
      warn: false,
    });
    expect(events).toEqual([]);
  });

  it("goes to options.logger over the router's", () => {
    const own = createTestLogger();
    const router = createTestLogger();
    const app = new BunHttpAdapter(0, { logger: router.logger });
    mountAuth(app, makePlainAuth({ advanced: {} }), { logger: own.logger });
    expect(warningsIn(own.events)).toEqual(["client-address"]);
    expect(router.events).toEqual([]);
    expect(own.events[0]?.name).toBe("bun-auth");
  });
});

describe("a route outside better-auth", () => {
  it("keeps the client's own header for the app's handlers", async () => {
    const app = new BunHttpAdapter(0, { logger: () => {} });
    mountAuth(app, makePlainAuth());
    app.get("/echo", (req: BunRequest, res: BunResponse) => {
      res.send(req.get(DEFAULT_CLIENT_IP_HEADER) ?? "none");
    });
    const echo = await app.fetch(`${ORIGIN}/echo`, {
      headers: { [DEFAULT_CLIENT_IP_HEADER]: "203.0.113.77" },
    });
    expect(await echo.text()).toBe("203.0.113.77");
  });
});
