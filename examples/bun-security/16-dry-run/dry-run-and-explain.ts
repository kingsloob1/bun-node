/**
 * Rolling a policy out safely: the whole policy in dry run, then
 * `explain()` to see why a request got its decision, without counting it.
 *
 * ```bash
 * bun 16-dry-run/dry-run-and-explain.ts
 * ```
 *
 * - `mode: "dryRun"` on the policy (or on one entry, rule or limit) makes
 *   every refusal a `log` that records `wouldHaveBeen`: run it in production
 *   for a while and read the decisions before enforcing.
 * - `explain(facts)` is the same decision as `evaluate()`, with no state
 *   written (limits are peeked, never counted), plus how the client was
 *   resolved and every check made. It is what an operator asks when a
 *   customer says "I was blocked".
 * - `onDecision(decision, facts)` sees every `evaluate()` decision: a place
 *   to log the dry run's would-be refusals.
 */
import { createSecurity } from "@kingsleyweb/bun-security";
import type { Decision, SecurityPolicy } from "@kingsleyweb/bun-security";
import { check, checkEqual, summary } from "../shared/check";
import { fakeClock, facts } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("dry run and explain()");

const POLICY: SecurityPolicy = {
  lists: [{ ip: "203.0.113.0/24", action: "block", reason: "scanner range" }],
  limits: [{ id: "search", limit: 2, window: "1m", routes: ["GET /search"] }],
  requestRules: {
    rules: [
      {
        id: "no-sqlmap",
        when: { header: "user-agent", contains: "sqlmap" },
        action: "ban",
        duration: "1d",
      },
    ],
  },
};

/* ------------------------------------------------------------------ */
step("the whole policy in dry run: nothing refused, everything recorded");
const wouldBe: Decision[] = [];
const dry = createSecurity({
  policy: { ...POLICY, mode: "dryRun" },
  now: fakeClock().now,
  onDecision: (decision) => {
    if (decision.hits.some((h) => h.wouldHaveBeen !== undefined))
      wouldBe.push(decision);
  },
  logger: () => {},
});
const requests = [
  facts("203.0.113.9"),
  facts("198.51.100.1", { headers: { "user-agent": "sqlmap/1.8" } }),
  facts("198.51.100.2", { path: "/search" }),
  facts("198.51.100.2", { path: "/search" }),
  facts("198.51.100.2", { path: "/search" }),
];
const actions = [];
for (const request of requests)
  actions.push((await dry.evaluate(request)).action);
show("actions", actions);
checkEqual(
  "every request let through",
  actions.every((a) => a === "allow" || a === "log"),
  true,
);
show(
  "would have been",
  wouldBe.map((d) => d.hits.map((h) => `${h.rule} → ${h.wouldHaveBeen}`)),
);
checkEqual(
  "…and three would-be refusals recorded",
  wouldBe.map(
    (d) => d.hits.find((h) => h.wouldHaveBeen !== undefined)?.wouldHaveBeen,
  ),
  ["block", "ban", "block"],
);
checkEqual("no ban made", dry.bans(), []);
dry.close();

/* ------------------------------------------------------------------ */
step("enforced, and explain(): why was this request refused?");
const security = createSecurity({
  policy: POLICY,
  now: fakeClock().now,
  logger: () => {},
});
const explained = await security.explain(
  facts("203.0.113.9", { path: "/search" }),
);
show("decision", {
  action: explained.decision.action,
  code: explained.decision.code,
});
show("client", {
  address: explained.client.address,
  source: explained.client.source,
});
show(
  "steps",
  explained.steps.map((s) => `${s.layer} ${s.check}: ${s.outcome}`),
);
checkEqual("refused", explained.decision.action, "block");
check(
  "a step names the list entry that refused it",
  explained.steps.some((s) => s.rule === "ip:203.0.113.0/24"),
  explained.steps,
);

/* ------------------------------------------------------------------ */
step("explain() writes nothing: the limit is peeked, never counted");
for (let i = 0; i < 5; i++)
  await security.explain(facts("198.51.100.3", { path: "/search" }));
const first = await security.evaluate(
  facts("198.51.100.3", { path: "/search" }),
);
checkEqual(
  "five explains later, the first real request still passes",
  first.action,
  "allow",
);

security.close();
summary();
