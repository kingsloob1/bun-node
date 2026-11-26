/**
 * The rate-limit warning (plan §8.4, Q3): once, when better-auth's own
 * limiter is on and bun-security (or a bun-common `throttle()`) also counted
 * the request. bun-auth never turns either off.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  createTestLogger,
  throttle,
} from "@kingsleyweb/bun-common";
import { createSecurity } from "@kingsleyweb/bun-security";
import { installSecurity } from "@kingsleyweb/bun-security/http";
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { mountAuth } from "../lib";
import { createLimiterCheck, loadRequestSecurity } from "../lib/limiter";
import {
  jsonPost,
  makePlainAuth,
  ORIGIN,
  PASSWORD,
  warningsIn,
} from "./helpers";

// Every case signs up or in through better-auth, whose scrypt hashing is
// CPU-bound: on a loaded machine one case outlasted bun:test's 5 s (seed
// 797066127 at a load of 161).
setDefaultTimeout(30_000);

const ON = { enabled: true, storage: "database" } as const;

/** An adapter, optionally under bun-security, with better-auth mounted. */
async function appWith(rateLimit: { enabled: boolean }, withSecurity: boolean) {
  const { logger, events } = createTestLogger();
  const app = new BunHttpAdapter(0, { logger });
  if (withSecurity) {
    await installSecurity(
      app,
      createSecurity<BunRequest>({
        policy: {},
        secret: "a-test-secret-of-at-least-thirty-two-bytes",
        logger: () => {},
      }),
      { logger: () => {} },
    );
  }
  const auth = makePlainAuth({ rateLimit: { ...ON, ...rateLimit } });
  mountAuth(app, auth);
  return { app, auth, events };
}

/** Two wrong sign-ins through `app`. */
async function twoSignIns(app: BunHttpAdapter): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await app.fetch(
      `${ORIGIN}/api/auth/sign-in/email`,
      jsonPost({ email: "nobody@example.test", password: PASSWORD }),
    );
  }
}

const limitWarnings = (events: Parameters<typeof warningsIn>[0]) =>
  warningsIn(events).filter((kind) => kind === "rate-limit");

describe("the rate-limit warning", () => {
  it("is logged once with bun-security installed and better-auth's limiter on", async () => {
    const { app, events } = await appWith({ enabled: true }, true);
    await twoSignIns(app);
    expect(limitWarnings(events)).toEqual(["rate-limit"]);
    const warning = events.find(
      (event) => event.fields.warning === "rate-limit",
    );
    expect(warning?.fields.other).toBe("bun-security");
    expect(warning?.message).toContain("rateLimit: { enabled: false }");
  });

  it("negative control: not with better-auth's limiter off", async () => {
    const { app, events } = await appWith({ enabled: false }, true);
    await twoSignIns(app);
    expect(limitWarnings(events)).toEqual([]);
  });

  it("negative control: not without bun-security", async () => {
    const { app, events } = await appWith({ enabled: true }, false);
    await twoSignIns(app);
    expect(limitWarnings(events)).toEqual([]);
  });

  it("is logged for a bun-common throttle() ahead of the mount", async () => {
    const { logger, events } = createTestLogger();
    const app = new BunHttpAdapter(0, { logger });
    app.use(throttle({ limit: 100, window: "1m" }));
    mountAuth(app, makePlainAuth({ rateLimit: ON }));
    await twoSignIns(app);
    expect(limitWarnings(events)).toEqual(["rate-limit"]);
    expect(
      events.find((event) => event.fields.warning === "rate-limit")?.fields
        .other,
    ).toBe("a bun-common throttle()");
  });

  it("is not logged with warn: false, and the app's setting is left as it was", async () => {
    const { logger, events } = createTestLogger();
    const app = new BunHttpAdapter(0, { logger });
    app.use(throttle({ limit: 100, window: "1m" }));
    const auth = makePlainAuth({ rateLimit: ON });
    mountAuth(app, auth, { warn: false });
    await twoSignIns(app);
    expect(events).toEqual([]);
    expect((await auth.$context).rateLimit.enabled).toBe(true);
    expect(auth.options.rateLimit).toEqual(ON);
  });
});

describe("createLimiterCheck", () => {
  it("finds bun-security's requestSecurity where the default loader looks", () => {
    expect(typeof loadRequestSecurity()).toBe("function");
  });

  it("loads bun-security only when better-auth's limiter is on, and once", async () => {
    let loads = 0;
    const load = () => {
      loads += 1;
      return () => undefined;
    };
    const off = createLimiterCheck(makePlainAuth(), load);
    expect(await off.check(new Request(`${ORIGIN}/x`))).toBeUndefined();
    expect(loads).toBe(0);
    const on = createLimiterCheck(makePlainAuth({ rateLimit: ON }), load);
    await on.check(new Request(`${ORIGIN}/x`));
    await on.check(new Request(`${ORIGIN}/y`));
    expect(loads).toBe(1);
  });

  it("answers nothing when bun-security is not installed", async () => {
    const check = createLimiterCheck(
      makePlainAuth({ rateLimit: ON }),
      () => undefined,
    );
    expect(await check.check(new Request(`${ORIGIN}/x`))).toBeUndefined();
  });
});
