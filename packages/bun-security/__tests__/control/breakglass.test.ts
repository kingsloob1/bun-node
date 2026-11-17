/**
 * The break-glass account (PR-CP3, Q11): a password and a single-use TOTP
 * code for a 15-minute token that acts as owner on global, its step-up
 * fresh for 5 minutes, five failures locking it for 15; every login and
 * failure audited, a login alerted, streamed and logged critical.
 */
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createTestLogger } from "@kingsleyweb/bun-common";
import type { SecurityAlertDto } from "../../lib/control/contract/index";
import { totpCode } from "../../lib/control/index";
import { base32Decode } from "../../lib/control/audit/breakglass";
import { memoryStore, postgresStore, sqliteStore } from "../../lib/store/index";
import type { SecurityStoreDriver } from "../../lib/store/index";
import { faultyStore } from "../../lib/testing/index";
import { fakeClock } from "../helpers";
import type { FakeClock } from "../helpers";
import {
  dropStore,
  freshPrefix,
  POSTGRES_URL,
  VARIABLE,
} from "../store/pgBackend";
import { testApi } from "./helpers";

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const PASSWORD = "correct horse battery staple";
// A cheap argon2id cost (verify follows the hash's own parameters), so a
// loaded machine's many logins stay well inside the test timeout.
const passwordHash = await Bun.password.hash(PASSWORD, {
  algorithm: "argon2id",
  memoryCost: 4096,
  timeCost: 1,
});
const HEADER = "x-bun-security-break-glass";

/** An API with break-glass, a step-up hook that never passes, and the alerts and log it raised. */
function breakGlassApi(store?: SecurityStoreDriver, clock?: FakeClock) {
  const alerts: SecurityAlertDto[] = [];
  const { logger, events } = createTestLogger();
  const test = testApi({
    ...(store === undefined ? {} : { store }),
    ...(clock === undefined ? {} : { now: clock.now }),
    allowWithoutStepUp: undefined,
    stepUp: { verify: () => false, challenge: () => "/mfa" },
    breakGlass: { passwordHash, totpSecret: SECRET },
    onAlert: (alert) => alerts.push(alert),
    logger,
  });
  /** The current code, `steps` steps from now. */
  const code = (steps = 0) =>
    totpCode(
      base32Decode(SECRET),
      Math.floor((clock ?? test.clock).now() / 30_000) + steps,
    );
  const login = (password: string, totp: string) =>
    test.call("POST", "/break-glass/session", { password, code: totp }, null);
  return { ...test, alerts, events, code, login };
}

describe("TOTP", () => {
  it("matches RFC 6238's SHA-1 vector (59 s → 94287082, its last 6 digits)", () => {
    const secret = new TextEncoder().encode("12345678901234567890");
    expect(totpCode(secret, 1)).toBe("287082");
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804");
  });

  it("refuses a plain password or a short secret in the options", () => {
    expect(() =>
      testApi({ breakGlass: { passwordHash: PASSWORD, totpSecret: SECRET } }),
    ).toThrow(/password hash/);
    expect(() =>
      testApi({ breakGlass: { passwordHash, totpSecret: "JBSWY3DP" } }),
    ).toThrow(/80 bits/);
  });
});

describe("the break-glass login", () => {
  it("is not routed unless configured", async () => {
    const { call } = testApi();
    expect(
      (
        await call(
          "POST",
          "/break-glass/session",
          { password: "x", code: "000000" },
          null,
        )
      ).status,
    ).toBe(404);
  });

  it("answers a 15-minute token for the password and a fresh code; acts as owner; audited, alerted, streamed and logged", async () => {
    const { api, call, login, code, alerts, events } = breakGlassApi();
    const live: string[] = [];
    api.plane.listen((event) => live.push(event.event));
    const answer = await login(PASSWORD, code());
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ header: HEADER });
    const as = { [HEADER]: answer.body.token };
    // Owner on global: not among the owners, still binds a role.
    expect(
      (
        await call(
          "POST",
          "/role-bindings",
          { operator: "eve", role: "admin", scope: "global" },
          null,
          as,
        )
      ).status,
    ).toBe(201);
    expect(
      (await call("GET", "/operators/me", undefined, null, as)).body,
    ).toMatchObject({ id: "break-glass" });
    expect(alerts.map((alert) => [alert.kind, alert.severity])).toContainEqual([
      "breakGlass.login",
      "critical",
    ]);
    expect(live).toContain("breakGlass.used");
    expect(
      events.some(
        (event) =>
          event.level === "error" && event.message.includes("break-glass"),
      ),
    ).toBe(true);
    const audit = (await call("GET", "/audit?direction=asc")).body.items;
    expect(audit[0]).toMatchObject({
      action: "breakGlass.login",
      phase: "event",
    });
    const binding = audit.find(
      (item: { action: string }) => item.action === "roleBinding.create",
    );
    expect(binding.entry.actor).toEqual({
      id: "break-glass",
      kind: "break-glass",
    });
    expect(binding.entry.stepUp).toBe(true);
  });

  it("refuses a wrong password, a wrong code, and a code already used; each failure audited", async () => {
    const { call, login, code } = breakGlassApi();
    expect((await login("wrong", code())).status).toBe(401);
    expect((await login(PASSWORD, "000000")).status).toBe(401);
    const current = code();
    expect((await login(PASSWORD, current)).status).toBe(200);
    expect((await login(PASSWORD, current)).status).toBe(401);
    // A neighbouring step is still accepted (±1), once.
    expect((await login(PASSWORD, code(1))).status).toBe(200);
    expect((await login(PASSWORD, code(2))).status).toBe(401);
    const failures = (await call("GET", "/audit?action=breakGlass.failed")).body
      .items;
    expect(failures).toHaveLength(4);
  });

  it("locks for 15 minutes after five failures, alerting; then lets the right code in", async () => {
    const { login, code, alerts, clock } = breakGlassApi();
    for (let attempt = 1; attempt <= 4; attempt++)
      expect((await login("wrong", code())).status).toBe(401);
    const fifth = await login("wrong", code());
    expect([fifth.status, fifth.body.code]).toEqual([
      429,
      "break_glass_locked",
    ]);
    expect(alerts.map((alert) => alert.kind)).toContain("breakGlass.locked");
    // Locked: even the right password and code are refused.
    expect((await login(PASSWORD, code())).status).toBe(429);
    clock.advance(15 * 60_000 + 1);
    expect((await login(PASSWORD, code())).status).toBe(200);
  });

  it("a token expires after 15 minutes, and a forged one is nobody", async () => {
    const { call, login, code, clock } = breakGlassApi();
    const token = (await login(PASSWORD, code())).body.token as string;
    expect(
      (await call("GET", "/services", undefined, null, { [HEADER]: token }))
        .status,
    ).toBe(200);
    const [payload, mac] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ iat: clock.now(), exp: clock.now() + 1e9, jti: "x" })).toString("base64url")}.${mac}`;
    expect(payload).toBeDefined();
    expect(
      (await call("GET", "/services", undefined, null, { [HEADER]: forged }))
        .status,
    ).toBe(401);
    clock.advance(15 * 60_000 + 1);
    expect(
      (await call("GET", "/services", undefined, null, { [HEADER]: token }))
        .status,
    ).toBe(401);
  });

  it("counts as a fresh step-up for 5 minutes only", async () => {
    const { call, login, code, clock } = breakGlassApi();
    const as = {
      [HEADER]: (await login(PASSWORD, code())).body.token as string,
    };
    await call(
      "PUT",
      "/policies/global/draft",
      { policy: {}, revision: null },
      null,
      as,
    );
    const first = await call(
      "POST",
      "/policies/global/publish",
      { expectedHead: null },
      null,
      as,
    );
    expect(first.status).toBe(200);
    // Negative control: an ordinary owner, through the same hook, is asked for one.
    await call("PUT", "/policies/global/draft", { policy: {}, revision: null });
    expect(
      (
        await call("POST", "/policies/global/publish", {
          expectedHead: first.body.version.id,
        })
      ).status,
    ).toBe(401);
    clock.advance(5 * 60_000 + 1);
    const later = await call(
      "POST",
      "/policies/global/publish",
      { expectedHead: first.body.version.id },
      null,
      as,
    );
    expect([later.status, later.body.code]).toEqual([401, "step_up_required"]);
  });

  it("refuses the login when its audit entry cannot be written", async () => {
    let down = true;
    const store = faultyStore(memoryStore(), {
      fail: (operation) =>
        operation === "appendAudit" && down
          ? new Error("audit down")
          : undefined,
    });
    const { login, code, alerts } = breakGlassApi(store);
    const refused = await login(PASSWORD, code());
    down = false;
    expect([refused.status, refused.body.code]).toEqual([
      503,
      "audit_unavailable",
    ]);
    expect(alerts.map((alert) => alert.kind)).not.toContain("breakGlass.login");
  });

  it("documents the login route when configured", async () => {
    const { call } = breakGlassApi();
    const openapi = (await call("GET", "/openapi.json")).body;
    expect(Object.keys(openapi.paths)).toContain("/break-glass/session");
  });
});

describe("break-glass state is shared by every instance on one store", () => {
  /** Two stores for two control-plane instances: one store shared, or (`apart`) two. */
  const backends: {
    name: string;
    pair: (
      clock: FakeClock,
      apart: boolean,
    ) => Promise<
      [SecurityStoreDriver, SecurityStoreDriver, () => Promise<void>]
    >;
  }[] = [
    {
      name: "memory (one store object)",
      pair: async (clock, apart) => {
        const one = memoryStore({ now: clock.now });
        return [
          one,
          apart ? memoryStore({ now: clock.now }) : one,
          async () => {},
        ];
      },
    },
    {
      name: "SQLite (two store objects on one file)",
      pair: async (clock, apart) => {
        const dir = mkdtempSync(join(tmpdir(), "bun-security-bg-"));
        const a = sqliteStore({ path: join(dir, "a.sqlite"), now: clock.now });
        const b = sqliteStore({
          path: join(dir, apart ? "b.sqlite" : "a.sqlite"),
          now: clock.now,
        });
        await a.connect();
        await b.connect();
        return [
          a,
          b,
          async () => {
            await a.close();
            await b.close();
            rmSync(dir, { recursive: true, force: true });
          },
        ];
      },
    },
    ...(POSTGRES_URL === undefined || POSTGRES_URL === ""
      ? []
      : [
          {
            name: "Postgres (two store objects on one prefix)",
            pair: async (
              clock: FakeClock,
              apart: boolean,
            ): Promise<
              [SecurityStoreDriver, SecurityStoreDriver, () => Promise<void>]
            > => {
              const first = freshPrefix();
              const second = apart ? freshPrefix() : first;
              const a = postgresStore({
                url: POSTGRES_URL,
                prefix: first,
                now: clock.now,
                max: 2,
              });
              const b = postgresStore({
                url: POSTGRES_URL,
                prefix: second,
                now: clock.now,
                max: 2,
              });
              await a.connect();
              await b.connect();
              return [
                a,
                b,
                async () => {
                  await a.close();
                  await b.close();
                  await dropStore(first);
                  if (second !== first) await dropStore(second);
                },
              ];
            },
          },
        ]),
  ];

  if (POSTGRES_URL === undefined || POSTGRES_URL === "") {
    it.skip(`Postgres: ${VARIABLE} is unset`, () => {});
  }

  for (const backend of backends) {
    it(`${backend.name}: five failures across two instances lock both, and a code used on one is refused on the other`, async () => {
      const clock = fakeClock();
      const [storeA, storeB, done] = await backend.pair(clock, false);
      try {
        const a = breakGlassApi(storeA, clock);
        const b = breakGlassApi(storeB, clock);
        // A code used on one instance is spent on the other.
        const current = a.code();
        expect((await a.login(PASSWORD, current)).status).toBe(200);
        expect((await b.login(PASSWORD, current)).status).toBe(401);
        for (const api of [a, b, a])
          expect((await api.login("wrong", a.code())).status).toBe(401);
        // The fifth failure, on the other instance: both are locked.
        expect((await b.login("wrong", a.code())).status).toBe(429);
        clock.advance(30_000);
        expect((await a.login(PASSWORD, a.code())).status).toBe(429);
        expect((await b.login(PASSWORD, a.code())).status).toBe(429);
        expect([...a.alerts, ...b.alerts].map((alert) => alert.kind)).toContain(
          "breakGlass.locked",
        );
        // Attempts while locked stay out of the chain (anonymous traffic cannot grow it).
        const failures = (
          await a.call("GET", "/audit?action=breakGlass.failed")
        ).body.items;
        expect(failures).toHaveLength(5);
        clock.advance(15 * 60_000);
        expect((await b.login(PASSWORD, b.code())).status).toBe(200);
      } finally {
        await done();
      }
    }, 30_000);

    it(`${backend.name}: negative control, two separate stores count apart`, async () => {
      const clock = fakeClock();
      const [storeA, storeB, done] = await backend.pair(clock, true);
      try {
        const a = breakGlassApi(storeA, clock);
        const b = breakGlassApi(storeB, clock);
        const current = a.code();
        expect((await a.login(PASSWORD, current)).status).toBe(200);
        // The same code, still unused in the other store.
        expect((await b.login(PASSWORD, current)).status).toBe(200);
        for (const api of [a, b, a, b, a])
          expect((await api.login("wrong", a.code())).status).toBe(401);
        // Three on one, two on the other: neither reached five.
        clock.advance(30_000);
        expect((await b.login(PASSWORD, b.code())).status).toBe(200);
      } finally {
        await done();
      }
    }, 30_000);
  }
});
