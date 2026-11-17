/**
 * Request rules (a WAF's rules, as data) and the managed probe set: a
 * condition over the request and what to do when it holds.
 *
 * ```bash
 * bun 07-request-rules/request-rules.ts
 * ```
 *
 * - Targets: `method`, `path` (canonical), `rawPath`, `query`, `queryParam`,
 *   `header`, `anyHeader`, `cookie`, `client`, `contentLength`,
 *   `headerCount`, the client's `country`, `asn` and `class`; and, once
 *   routing and `identify()` have run, `routeKey`, `user`, `session`,
 *   `tenant` and `apiKey`. Combine tests with `all`, `any` and `not`.
 * - Regular expressions are restricted (no backtracking blow-ups): a pattern
 *   that could run away refuses the policy, and `regexRefusal()` says why.
 * - The managed probe set (`.env`, `.git`, WordPress, phpMyAdmin, …) is on
 *   by default in dry run; `{ mode: "enforce" }` makes it act. A probe is
 *   answered as a missing page (`404`), so a scanner learns nothing.
 * - Each enforced hit counts `rule.hit` (the probe set's `probe.hit`) for
 *   counted rules, and its `weight` on the offence ladder.
 */
import { createSecurity, regexRefusal } from "@kingsleyweb/bun-security";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { fakeClock, facts } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("request rules and the managed probe set");

const security = createSecurity({
  policy: {
    requestRules: {
      rules: [
        {
          id: "no-scanners",
          when: {
            any: [
              { header: "user-agent", contains: "sqlmap", ignoreCase: true },
              { queryParam: "id", regex: "'\\s*or\\s+\\d", ignoreCase: true },
            ],
          },
          action: "ban",
          duration: "1d",
          weight: 5,
        },
        // Read in the route stage, once identify() has named the caller.
        {
          id: "staff-only",
          when: {
            all: [
              { path: { prefix: "/admin" } },
              { not: { user: { prefix: "staff_" } } },
            ],
          },
        },
        {
          id: "no-debug",
          when: { header: "x-debug", exists: true },
          status: 400,
          code: "debug_refused",
        },
      ],
      managed: { mode: "enforce" },
    },
    // Five rule hits in a minute from one address: a ban. The ladder (each
    // hit weighs 1; a challenge at 3) is off here, so this rule alone acts.
    countedRules: [
      {
        id: "rule-hits",
        event: "rule.hit",
        threshold: 5,
        window: "1m",
        duration: "1h",
      },
    ],
    ladder: false,
  },
  now: fakeClock().now,
  logger: () => {},
});

/* ------------------------------------------------------------------ */
step("rules of your own");
const sqlmap = await security.evaluate(
  facts("198.51.100.1", { headers: { "user-agent": "sqlmap/1.8" } }),
);
checkEqual("a scanner's User-Agent: banned", sqlmap.action, "ban");
const injection = await security.evaluate(
  facts("198.51.100.2", { path: "/item?id=1'%20or%201=1" }),
);
checkEqual("an injection probe in ?id: banned", injection.action, "ban");
const ordinary = await security.evaluate(
  facts("198.51.100.3", { path: "/item?id=42" }),
);
checkEqual("an ordinary ?id passes", ordinary.action, "allow");
const visitor = await security.evaluate(
  facts("198.51.100.3", { path: "/admin/users", identity: { user: "u_ada" } }),
);
const staff = await security.evaluate(
  facts("198.51.100.3", {
    path: "/admin/users",
    identity: { user: "staff_bob" },
  }),
);
checkEqual(
  "/admin: a visitor blocked, staff let in",
  [visitor.action, staff.action],
  ["block", "allow"],
);
const debug = await security.evaluate(
  facts("198.51.100.3", { headers: { "x-debug": "1" } }),
);
checkEqual(
  "a rule's own status and code",
  [debug.status, debug.code],
  [400, "debug_refused"],
);
show(
  "why /admin was refused",
  visitor.hits.map((h) => h.rule),
);

/* ------------------------------------------------------------------ */
step("the managed probe set, enforced");
const probes = [
  "/.env",
  "/.git/config",
  "/wp-login.php",
  "/phpmyadmin/index.php",
];
const answers = [];
for (const [i, path] of probes.entries()) {
  const decision = await security.evaluate(
    facts(`198.51.100.${10 + i}`, { path }),
  );
  answers.push([path, decision.status, decision.code, decision.hits[0]?.rule]);
}
show("probes", answers);
check(
  "each refused as a missing page, by its probe rule",
  answers.every(
    ([, status, code, rule]) =>
      status === 404 &&
      code === "not_found" &&
      String(rule).startsWith("probe:"),
  ),
  answers,
);

/* ------------------------------------------------------------------ */
step("rule hits feed a counted rule on rule.hit");
const prober = "198.51.100.20";
const seen: string[] = [];
for (let i = 0; i < 6; i++)
  seen.push(
    (await security.evaluate(facts(prober, { path: "/admin/x" }))).action,
  );
show("six refused requests to /admin", seen);
checkEqual("the fifth hit trips the ban", seen, [
  "block",
  "block",
  "block",
  "block",
  "ban",
  "ban",
]);

/* ------------------------------------------------------------------ */
step("regular expressions that could run away are refused");
show("regexRefusal('(a+)+$')", regexRefusal("(a+)+$"));
checkEqual(
  "an ordinary pattern is fine",
  regexRefusal("^/api/v\\d+/"),
  undefined,
);
await checkRejects(
  "a policy with a nested quantifier is refused",
  () =>
    createSecurity({
      policy: {
        requestRules: {
          rules: [{ id: "bad", when: { path: { regex: "(a+)+$" } } }],
        },
      },
    }),
  { name: "SecurityPolicyError" },
);

security.close();
summary();
