/**
 * Lists and bans: allow, block and drop entries with scopes, expiry and dry
 * run; the built-in `internal` list; bans by hand; and the offence score's
 * ladder turning repeated offences into a ban.
 *
 * ```bash
 * bun 04-lists-and-bans/lists-and-bans.ts
 * ```
 *
 * - The most specific scope that matched decides (route `paths` > service >
 *   group > global); within it an `allow` marked `override` wins, otherwise
 *   the most severe action does.
 * - No address entry refuses an internal client (loopback, RFC 1918, CGNAT,
 *   link-local, ULA): a block on `10.0.0.0/8` would cut off your own proxy.
 * - A ban answers `403` with `code: "banned"` and no `Retry-After`.
 * - The engine runs on a fake clock here (`now`), so an hour passes in a line.
 */
import { createSecurity } from "@kingsleyweb/bun-security";
import { checkEqual, summary } from "../shared/check";
import { fakeClock, facts } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("lists, bans and the ladder");

const clock = fakeClock();
const security = createSecurity({
  policy: {
    lists: [
      { ip: "203.0.113.0/24", action: "block", reason: "scanner range" },
      // An override allow inside the blocked range: the partner's office.
      {
        ip: "203.0.113.50",
        action: "allow",
        override: true,
        reason: "partner",
      },
      { ip: "198.51.100.66", action: "drop" },
      // Only the admin area, and only until the end of the year.
      {
        ip: "198.51.100.0/24",
        action: "block",
        paths: ["/admin"],
        expiresAt: "2026-12-31T23:59:59Z",
      },
      // Dry run: recorded as what it would have done, never refused.
      { ip: "192.0.2.0/24", action: "block", mode: "dryRun" },
      // Would cut off the proxy: the internal list wins.
      { ip: "10.0.0.0/8", action: "block" },
    ],
    // Every request scores 0 by default; this makes a custom event weigh 4.
    ladder: { weights: { "form.spam": 4 } },
  },
  now: clock.now,
  logger: () => {},
});

/** The action for a request from `client` to `path`. */
const action = async (client: string, path = "/") =>
  (await security.evaluate(facts(client, { path }))).action;

/* ------------------------------------------------------------------ */
step("list entries");
const verdicts = {
  "203.0.113.9 (blocked range)": await action("203.0.113.9"),
  "203.0.113.50 (override allow)": await action("203.0.113.50"),
  "198.51.100.66 (drop)": await action("198.51.100.66"),
  "198.51.100.7 on /": await action("198.51.100.7", "/"),
  "198.51.100.7 on /admin/users": await action("198.51.100.7", "/admin/users"),
  "198.51.100.7 on //Admin (canonical path)": await action(
    "198.51.100.7",
    "//Admin",
  ),
  "10.0.0.5 (internal)": await action("10.0.0.5"),
};
show("verdicts", verdicts);
checkEqual("each entry decides as written", verdicts, {
  "203.0.113.9 (blocked range)": "block",
  "203.0.113.50 (override allow)": "allow",
  "198.51.100.66 (drop)": "drop",
  "198.51.100.7 on /": "allow",
  "198.51.100.7 on /admin/users": "block",
  "198.51.100.7 on //Admin (canonical path)": "block",
  "10.0.0.5 (internal)": "allow",
});
const dry = await security.evaluate(facts("192.0.2.4"));
show("dry run", dry.hits);
checkEqual("dry run: logged", dry.action, "log");
checkEqual(
  "…with what it would have done",
  dry.hits[0]?.wouldHaveBeen,
  "block",
);

/* ------------------------------------------------------------------ */
step("a ban by hand, and lifting it");
const ban = security.ban({
  ip: "198.51.100.20",
  duration: "1h",
  reason: "abuse report",
  by: "ops",
});
show("ban", { id: ban.id, expiresAt: ban.expiresAt });
const banned = await security.evaluate(facts("198.51.100.20"));
checkEqual(
  "banned",
  [banned.action, banned.code, banned.retryAfter],
  ["ban", "banned", undefined],
);
checkEqual(
  "bans() lists it",
  security.bans().map((b) => b.id),
  ["ip:198.51.100.20"],
);
clock.advance(61 * 60_000);
checkEqual(
  "an hour later it has ended",
  await action("198.51.100.20"),
  "allow",
);
security.ban({ user: "u_mallory", duration: null }); // until lifted
checkEqual(
  "a user ban, until lifted",
  (
    await security.evaluate(
      facts("198.51.100.21", { identity: { user: "u_mallory" } }),
    )
  ).action,
  "ban",
);
security.unban("user:u_mallory", { by: "ops" });
checkEqual(
  "unban() lifts it",
  (
    await security.evaluate(
      facts("198.51.100.21", { identity: { user: "u_mallory" } }),
    )
  ).action,
  "allow",
);

/* ------------------------------------------------------------------ */
step("the ladder: offences add to a score, the score bans");
// The defaults: a challenge at 3, a ban at 10. Each "form.spam" weighs 4.
const spammer = "198.51.100.30";
const after: string[] = [];
for (let i = 0; i < 3; i++) {
  await security.signal(facts(spammer), "form.spam");
  after.push(await action(spammer));
}
show("after each offence", after);
// Score 4: a challenge (a block, with no challenge flow); 8: still; 12: a ban.
checkEqual("challenge, challenge, ban", after, ["block", "block", "ban"]);
show(
  "the ladder's ban",
  security.bans().find((b) => b.id === `ip:${spammer}`)?.rule,
);

security.close();
summary();
