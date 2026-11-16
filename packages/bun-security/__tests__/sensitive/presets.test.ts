/**
 * The presets (plan §17.4, "presets, staged"): L9.3's per-address and
 * per-user limits on and enforced; the sensitive endpoints' rules on, for
 * routes marked with their profile only; `not_found_per_minute` off; each
 * turned on or off by id, or replaced by a rule of the policy with its id;
 * an unknown id refused.
 */
import { describe, expect, it } from "bun:test";
import {
  compilePolicy,
  PRESETS,
  PROFILE_NAMES,
  SecurityPolicyError,
} from "../../lib/index";
import type { RequestFacts, Security } from "../../lib/index";
import { policyInternals } from "../../lib/policy/compile";
import { facts } from "../helpers";
import { engine, fakeClock } from "./helpers";

/** The ids of the compiled policy's limits and counted rules. */
function ids(policy: Parameters<typeof compilePolicy>[0]): string[] {
  const internals = policyInternals(compilePolicy(policy));
  return [...internals.limits, ...internals.countedRules].map(
    (rule) => rule.id,
  );
}

/** The actions of `n` evaluations of `request`. */
async function actions(security: Security, request: RequestFacts, n: number) {
  const out: string[] = [];
  for (let i = 0; i < n; i++)
    out.push((await security.evaluate(request)).action);
  return out;
}

describe("the presets", () => {
  it("are on by default except not_found_per_minute, and every one is named and known", () => {
    expect(ids({})).toEqual(
      Object.entries(PRESETS)
        .filter(([, preset]) => preset.on)
        .map(([id]) => id)
        .sort((a, b) => {
          const order = (id: string) => (PRESETS[id]?.kind === "limit" ? 0 : 1);
          return order(a) - order(b);
        }),
    );
    expect(PRESETS.not_found_per_minute?.on).toBe(false);
    expect(PROFILE_NAMES).toEqual(["login", "mfa", "otp", "reset", "signup"]);
    for (const [id, preset] of Object.entries(PRESETS)) {
      expect(preset.rule.id).toBe(id);
    }
  });

  it("per-ip refuses the 601st request a minute from one address on one route, enforced", async () => {
    const security = engine({}, fakeClock());
    const request = facts({ client: "198.51.100.1" });
    const results = await actions(security, request, 601);
    expect(results.slice(0, 600).every((action) => action === "allow")).toBe(
      true,
    );
    const refused = await security.evaluate(request);
    expect(refused).toMatchObject({ action: "block", status: 429 });
    expect(refused.hits[0]?.rule).toBe("limit:per-ip");
    // Another route counts apart (the key is the address and the route).
    const other = await security.evaluate(
      facts({ client: "198.51.100.1", path: "/other", rawPath: "/other" }),
    );
    expect(other.action).toBe("allow");
  });

  it("per-user refuses the 1001st request a minute of one user", async () => {
    const security = engine({ presets: { "per-ip": false } }, fakeClock());
    const request = (i: number) =>
      facts({
        client: `198.51.100.${(i % 200) + 1}`,
        identity: { user: "u_1" },
      });
    for (let i = 0; i < 1000; i++) {
      expect((await security.evaluate(request(i))).action).toBe("allow");
    }
    expect((await security.evaluate(request(1000))).hits[0]?.rule).toBe(
      "limit:per-user",
    );
  });

  it("turn off or on by id, and give way to a rule of the policy with their id", async () => {
    expect(ids({ presets: { "per-ip": false } })).not.toContain("per-ip");
    expect(ids({ presets: { not_found_per_minute: true } })).toContain(
      "not_found_per_minute",
    );
    const replaced = policyInternals(
      compilePolicy({ limits: [{ id: "per-ip", limit: 2, window: "1m" }] }),
    ).limits.filter((limit) => limit.id === "per-ip");
    expect(replaced.map((limit) => [limit.limit, limit.key.parts])).toEqual([
      [2, ["ip"]],
    ]);
    const security = engine(
      { limits: [{ id: "per-ip", limit: 2, window: "1m" }] },
      fakeClock(),
    );
    expect(await actions(security, facts(), 3)).toEqual([
      "allow",
      "allow",
      "block",
    ]);
    expect(() =>
      compilePolicy({ presets: { "no-such": true } } as never),
    ).toThrow(SecurityPolicyError);
    expect(() =>
      compilePolicy({ presets: { "per-ip": "yes" } } as never),
    ).toThrow(SecurityPolicyError);
  });

  it("scope the sensitive endpoints' rules to their profile: login.ip holds on a login route, not elsewhere", async () => {
    const security = engine({ profiles: { login: false } }, fakeClock());
    const marked = facts({
      client: "198.51.100.9",
      method: "POST",
      path: "/login",
      rawPath: "/login",
      routeKey: "POST /login",
      profile: "login",
    });
    const unmarked = { ...marked, profile: undefined };
    const onLogin = await actions(security, marked, 31);
    expect(onLogin.slice(0, 30).every((action) => action === "allow")).toBe(
      true,
    );
    expect(onLogin[30]).toBe("block");
    expect(
      (await actions(security, unmarked, 40)).every(
        (action) => action === "allow",
      ),
    ).toBe(true);
  });

  it("key the code-sending limits on the destination and its prefix (SMS pumping)", async () => {
    const security = engine(
      { presets: { "otp.ip": false, "otp.ip-hour": false } },
      fakeClock(),
    );
    const send = (destination: string, client: string) =>
      facts({
        client,
        method: "POST",
        path: "/otp",
        rawPath: "/otp",
        routeKey: "POST /otp",
        profile: "otp",
        identity: { destination },
      });
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(
        (
          await security.evaluate(
            send("+234 801 234 5678", `198.51.100.${i + 1}`),
          )
        ).action,
      );
    }
    // 3 per 10 minutes per destination, whatever the address and formatting.
    expect(results).toEqual(["allow", "allow", "allow", "block"]);
    // Another destination of the same prefix still passes.
    expect(
      (await security.evaluate(send("+2348012345679", "198.51.100.50"))).action,
    ).toBe("allow");
  });
});
