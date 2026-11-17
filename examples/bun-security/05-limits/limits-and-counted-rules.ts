/**
 * Rate limits and counted rules: limits counted by bun-common's throttle,
 * keyed and selected by the policy; "N occurrences of an event in W → a ban
 * for B" on the engine's events and the app's own signals.
 *
 * ```bash
 * bun 05-limits/limits-and-counted-rules.ts
 * ```
 *
 * - A limit's `key` is `ip` (IPv6 by its /64), `user`, `session`, `tenant`,
 *   `apiKey`, `route`, or a composite (`["ip", "user"]`); `routes` picks the
 *   requests it counts. A window takes a unit (`"1m"`); a bare number is
 *   refused.
 * - A refused request gets `429` with `Retry-After`, and emits `throttled`.
 * - A counted rule's events: `request`, `throttled`, `route.notFound`,
 *   `server.error`, and any `security.signal(facts, name)`. At the threshold
 *   the counter is cleared and the key banned for `duration`.
 * - The engine runs on a fake clock (`now`), so windows pass in a line.
 */
import { createSecurity } from "@kingsleyweb/bun-security";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { fakeClock, facts } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("limits and counted rules");

const clock = fakeClock();
const security = createSecurity({
  policy: {
    limits: [
      // Per address and account on sign-in, and per address against spraying.
      {
        id: "signin-account",
        limit: 3,
        window: "1m",
        key: ["ip", "user"],
        routes: ["POST /auth/signin"],
      },
      {
        id: "signin-ip",
        limit: 10,
        window: "1m",
        routes: ["POST /auth/signin"],
      },
      // Counted and recorded, never refusing: trying a figure out first.
      {
        id: "search",
        limit: 2,
        window: "1m",
        routes: ["GET /search"],
        mode: "dryRun",
      },
    ],
    countedRules: [
      {
        id: "failed-password",
        event: "auth.failure",
        threshold: 3,
        window: "15m",
        duration: "1h",
      },
      {
        id: "not-found",
        event: "route.notFound",
        threshold: 5,
        window: "60s",
        duration: "1d",
      },
      {
        id: "repeat-429",
        event: "throttled",
        threshold: 3,
        window: "10m",
        duration: "1h",
      },
    ],
  },
  now: clock.now,
  logger: () => {},
});

/** A sign-in attempt by `user` from `client`. */
const signin = (client: string, user: string) =>
  facts(client, { method: "POST", path: "/auth/signin", identity: { user } });

/* ------------------------------------------------------------------ */
step("a composite key: 3 a minute per address and account");
const ada = [];
for (let i = 0; i < 4; i++)
  ada.push(await security.evaluate(signin("198.51.100.1", "ada")));
show(
  "ada from 198.51.100.1",
  ada.map((d) => d.status ?? 200),
);
checkEqual(
  "the fourth is refused",
  ada.map((d) => d.status ?? 200),
  [200, 200, 200, 429],
);
const refusal = ada[3];
show("the refusal", {
  status: refusal.status,
  code: refusal.code,
  retryAfter: refusal.retryAfter,
});
check("with Retry-After", (refusal.retryAfter ?? 0) > 0, refusal);
checkEqual(
  "another account from the same address is counted apart",
  (await security.evaluate(signin("198.51.100.1", "bob"))).action,
  "allow",
);
// The default algorithm is a sliding window: the last minute's count weighs
// on the next one, so Retry-After said about a minute and a half.
clock.advance(refusal.retryAfter! * 1000);
checkEqual(
  "after Retry-After ada may try again",
  (await security.evaluate(signin("198.51.100.1", "ada"))).action,
  "allow",
);

/* ------------------------------------------------------------------ */
step("a limit in dry run counts, records, and lets everything through");
const searches = [];
for (let i = 0; i < 3; i++)
  searches.push(
    await security.evaluate(facts("198.51.100.2", { path: "/search" })),
  );
show("third search", searches[2]?.hits);
checkEqual(
  "allowed (logged)",
  searches.map((d) => d.action),
  ["allow", "allow", "log"],
);
checkEqual(
  "…as a would-be block",
  searches[2]?.hits[0]?.wouldHaveBeen,
  "block",
);

/* ------------------------------------------------------------------ */
step(
  "a counted rule on the app's own signal: 3 failed passwords in 15 minutes → a 1 h ban",
);
for (let i = 0; i < 3; i++)
  await security.signal(facts("198.51.100.3"), "auth.failure");
const failed = await security.evaluate(facts("198.51.100.3"));
checkEqual("banned", failed.action, "ban");
checkEqual(
  "by the rule",
  security.bans().find((b) => b.id === "ip:198.51.100.3")?.rule,
  "counted:failed-password",
);

/* ------------------------------------------------------------------ */
step("a counted rule on route-not-found answers, reported by complete()");
const fuzzer = "198.51.100.4";
for (let i = 0; i < 5; i++) {
  const request = facts(fuzzer, { path: `/wp-${i}.php` });
  const decision = await security.evaluate(request, { track: true });
  await security.complete(request, decision, {
    status: 404,
    routeNotFound: true,
  });
}
checkEqual(
  "the fuzzer is banned for a day",
  (await security.evaluate(facts(fuzzer))).action,
  "ban",
);

/* ------------------------------------------------------------------ */
step("a counted rule on throttled: three 429s in 10 minutes → a ban");
const hammer = "198.51.100.5";
const outcomes: string[] = [];
for (let i = 0; i < 9; i++)
  outcomes.push(
    (await security.evaluate(signin(hammer, `user${i % 2}`))).action,
  );
show("outcomes", outcomes);
checkEqual("limited, then banned", outcomes.at(-1), "ban");

/* ------------------------------------------------------------------ */
step("a window needs its unit");
await checkRejects(
  "a bare number is refused",
  () =>
    createSecurity({
      policy: {
        limits: [{ id: "x", limit: 1, window: 60 as unknown as "1m" }],
      },
    }),
  { name: "SecurityPolicyError", message: /unit/ },
);

security.close();
summary();
