/**
 * The presets: built-in rules a policy gets without writing them, each with
 * an id, switched in `presets` with `true` (as it ships), `"enforce"` (on and
 * enforced) or `false` (off).
 *
 * ```bash
 * bun 06-presets/presets.ts
 * ```
 *
 * - On and enforced as they ship: `per-ip` (600 a minute per address and
 *   route), `per-user` (1,000 a minute), and the sensitive endpoints' rules,
 *   which count only on routes marked with their profile (`login.ip`: 30
 *   sign-ins a minute per address on a `login` route, …).
 * - On in dry run as it ships: `not_found_per_minute` (120 route-not-found
 *   answers a minute → a day's ban), which records the bans it would make.
 *   `"enforce"` makes it act.
 * - A rule of the policy's own with a preset's id replaces the preset.
 */
import { createSecurity, PRESETS } from "@kingsleyweb/bun-security";
import type { SecurityPolicy } from "@kingsleyweb/bun-security";
import { checkEqual, checkRejects, summary } from "../shared/check";
import { fakeClock, facts } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("the presets");

show("preset ids", Object.keys(PRESETS));

/** An engine over `policy` on a fake clock. */
const engine = (policy: SecurityPolicy) =>
  createSecurity({ policy, now: fakeClock().now, logger: () => {} });

/** The hits `complete()` reported, across every {@link fuzz}. */
const tripped: { rule: string; action: string; wouldHaveBeen?: string }[] = [];

/** Sends `count` requests from `client` that no route matched; each one's action. */
async function fuzz(
  security: ReturnType<typeof engine>,
  client: string,
  count: number,
) {
  const actions: string[] = [];
  for (let i = 0; i < count; i++) {
    const request = facts(client, { path: `/fuzz-${i}` });
    const decision = await security.evaluate(request, { track: true });
    actions.push(decision.action);
    // The outcome is where a counted rule on route.notFound counts and trips.
    tripped.push(
      ...(await security.complete(request, decision, {
        status: 404,
        routeNotFound: true,
      })),
    );
  }
  return actions;
}

/* ------------------------------------------------------------------ */
step(
  "as shipped: not_found_per_minute in dry run records the ban it would make",
);
const shipped = engine({});
const asShipped = await fuzz(shipped, "198.51.100.1", 130);
checkEqual(
  "every request served",
  asShipped.filter((a) => a !== "allow" && a !== "log"),
  [],
);
checkEqual("no ban made", shipped.bans(), []);
show("the trip complete() reported", tripped);
checkEqual(
  "…but recorded the ban it would have made",
  tripped.map((h) => [h.rule, h.action, h.wouldHaveBeen]),
  [["counted:not_found_per_minute", "log", "ban"]],
);

/* ------------------------------------------------------------------ */
step('"enforce": the same burst bans the fuzzer');
const enforced = engine({ presets: { not_found_per_minute: "enforce" } });
const actions = await fuzz(enforced, "198.51.100.2", 130);
show(
  "first refusal at",
  actions.findIndex((a) => a === "ban"),
);
checkEqual(
  "banned after 120 not-found answers",
  actions.findIndex((a) => a === "ban"),
  120,
);
checkEqual(
  "by the preset",
  enforced.bans()[0]?.rule,
  "counted:not_found_per_minute",
);

/* ------------------------------------------------------------------ */
step("false: off");
const off = engine({ presets: { not_found_per_minute: false } });
await fuzz(off, "198.51.100.3", 130);
const quiet = await off.evaluate(facts("198.51.100.3"));
checkEqual("nothing recorded", quiet.hits, []);

/* ------------------------------------------------------------------ */
step("the login presets count only on a route marked login");
const login = engine({});
const attempts: (number | undefined)[] = [];
for (let i = 0; i < 31; i++) {
  const decision = await login.evaluate(
    facts("198.51.100.4", {
      method: "POST",
      path: "/login",
      routeKey: "POST /login",
      profile: "login",
    }),
  );
  attempts.push(decision.status);
}
checkEqual("login.ip: the 31st sign-in a minute is 429", attempts.at(-1), 429);
const unmarked = await login.evaluate(
  facts("198.51.100.4", { method: "POST", path: "/login" }),
);
checkEqual("an unmarked route is not counted by it", unmarked.action, "allow");

/* ------------------------------------------------------------------ */
step("a rule of your own with a preset's id replaces it");
const replaced = engine({
  limits: [{ id: "per-ip", limit: 2, window: "1m", key: ["ip", "route"] }],
});
const three = [];
for (let i = 0; i < 3; i++)
  three.push((await replaced.evaluate(facts("198.51.100.5"))).status ?? 200);
checkEqual("2 a minute instead of 600", three, [200, 200, 429]);

await checkRejects(
  "any other value is refused",
  () =>
    createSecurity({
      policy: { presets: { "per-ip": "on" as unknown as true } },
    }),
  { name: "SecurityPolicyError" },
);

summary();
