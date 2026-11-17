/**
 * IP intelligence from ranges you choose: static classes (an office, a
 * partner) and a range feed (a Tor exit list here, served from localhost),
 * as `class` conditions in the policy.
 *
 * ```bash
 * bun 11-intel/static-ranges.ts
 * ```
 *
 * - No data ships with the package. Countries and ASNs come from MaxMind DB
 *   files you download (`databases`); classes from static `ranges` and from
 *   range `feeds` you configure. Nothing is fetched until `start()` or
 *   `refresh()`.
 * - A bad copy never empties a class: a download holding fewer than
 *   `minEntries` ranges (100 for `torExitFeed`) is refused and the last good
 *   copy kept.
 * - A policy that needs what the engine cannot know is refused at start: a
 *   `class` condition with no `intel`, or naming a class nothing provides.
 */
import { createSecurity } from "@kingsleyweb/bun-security";
import type { SecurityPolicy } from "@kingsleyweb/bun-security";
import { ipIntel, torExitFeed } from "@kingsleyweb/bun-security/intel";
import { checkEqual, checkRejects, summary } from "../shared/check";
import { facts } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("IP intelligence from static ranges and a feed");

/** The exit list the local server answers: 150 addresses, or 3 when truncated. */
let exitList = Array.from({ length: 150 }, (_, i) => `192.0.2.${i + 1}`).join(
  "\n",
);
const feedServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(exitList),
});

try {
  const intel = await ipIntel({
    ranges: { office: ["198.51.100.0/28"] },
    feeds: [torExitFeed({ url: `http://127.0.0.1:${feedServer.port}/exits` })],
    logger: () => {},
  });

  /* ------------------------------------------------------------------ */
  step("refresh the feed (in production: intel.start(), or a scheduled job)");
  const refreshed = await intel.refresh();
  show("refresh", refreshed);
  checkEqual(
    "the exit list loaded",
    refreshed.map((r) => [r.id, r.ok, r.entries]),
    [["tor", true, 150]],
  );
  show("lookup 192.0.2.7", intel.lookup("192.0.2.7"));
  checkEqual("an exit is in class tor", intel.lookup("192.0.2.7").classes, [
    "tor",
  ]);
  checkEqual(
    "the office is in class office",
    intel.lookup("198.51.100.3").classes,
    ["office"],
  );

  const policy: SecurityPolicy = {
    requestRules: {
      rules: [
        // No sign-ins through Tor; the rest of the site is open.
        {
          id: "no-tor-logins",
          when: {
            all: [{ class: { equals: "tor" } }, { path: { prefix: "/login" } }],
          },
        },
        // The admin area only from the office.
        {
          id: "office-admin",
          when: {
            all: [
              { path: { prefix: "/admin" } },
              { not: { class: { equals: "office" } } },
            ],
          },
        },
      ],
    },
  };
  const security = createSecurity({ policy, intel, logger: () => {} });

  /* ------------------------------------------------------------------ */
  step("class conditions");
  const verdicts = {
    "tor → /login": (
      await security.evaluate(facts("192.0.2.7", { path: "/login" }))
    ).action,
    "tor → /pricing": (
      await security.evaluate(facts("192.0.2.7", { path: "/pricing" }))
    ).action,
    "office → /admin": (
      await security.evaluate(facts("198.51.100.3", { path: "/admin" }))
    ).action,
    "elsewhere → /admin": (
      await security.evaluate(facts("203.0.113.9", { path: "/admin" }))
    ).action,
  };
  show("verdicts", verdicts);
  checkEqual("each as the rules say", verdicts, {
    "tor → /login": "block",
    "tor → /pricing": "allow",
    "office → /admin": "allow",
    "elsewhere → /admin": "block",
  });

  /* ------------------------------------------------------------------ */
  step("a truncated download is refused; the last good list stays");
  exitList = "192.0.2.1\n192.0.2.2\n192.0.2.3";
  const truncated = await intel.refresh({ force: true });
  show("refresh", truncated);
  checkEqual("refused", truncated[0]?.ok, false);
  checkEqual(
    "an exit is still in class tor",
    intel.lookup("192.0.2.150").classes,
    ["tor"],
  );

  /* ------------------------------------------------------------------ */
  step("a policy the engine cannot answer is refused at start");
  await checkRejects(
    "a class condition with no intel",
    () => createSecurity({ policy, logger: () => {} }),
    { message: /intel/ },
  );
  await checkRejects(
    "a class no feed or range provides",
    () =>
      createSecurity({
        policy: {
          requestRules: {
            rules: [{ id: "x", when: { class: { equals: "hosting" } } }],
          },
        },
        intel,
        logger: () => {},
      }),
    { message: /hosting/ },
  );

  security.close();
  intel.stop();
} finally {
  await feedServer.stop(true);
}

summary();
