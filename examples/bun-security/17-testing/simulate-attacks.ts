/**
 * Testing your own policy with `./testing`'s attack simulators: credential
 * stuffing, path scanning and a spoofed crawler against your app, each with
 * its negative control (the same app with no engine, where the attack
 * succeeds).
 *
 * ```bash
 * bun 17-testing/simulate-attacks.ts
 * ```
 *
 * - A simulator is a list of requests (`{ method, path, client, headers,
 *   body, at }`); `runAttack(attack, target, options)` sends them in order
 *   and reports outcomes: each status, the refusals and their problem codes,
 *   and where the first refusal came. Never speed.
 * - `fetchTarget(app)` uses the app's socket-free `fetch()`: no port, no
 *   network. `handlerTarget(handler)` does the same for `withSecurity`.
 * - Time is the requests' `at`: `advance` moves your engine's fake clock
 *   there, so a 50-minute attack runs in a moment. `settle` lets each
 *   answer's outcome reach the engine before the next request.
 * - In a test suite these are assertions in `bun:test`; here they are checks.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "@kingsleyweb/bun-security";
import type { Security } from "@kingsleyweb/bun-security";
import {
  installSecurity,
  securityProfile,
  uniformAuthResponse,
} from "@kingsleyweb/bun-security/http";
import {
  credentialStuffing,
  fetchTarget,
  paced,
  pathScan,
  PROBE_PATHS,
  runAttack,
  spoofedCrawler,
} from "@kingsleyweb/bun-security/testing";
import type { Attack } from "@kingsleyweb/bun-security/testing";
import { checkEqual, summary } from "../shared/check";
import { fakeClock } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("testing a policy with simulated attacks");

/** Your app: a sign-in and a home page, with the engine or without (`defences: false`). */
async function myApp(defences: boolean) {
  const clock = fakeClock();
  const app = new BunHttpAdapter(0, { logger: () => {} });
  let security: Security<BunRequest> | undefined;
  if (defences) {
    security = createSecurity<BunRequest>({
      policy: {
        presets: { not_found_per_minute: "enforce" },
        requestRules: { managed: { mode: "enforce" } },
      },
      secret: "an-example-secret-of-at-least-32-bytes!",
      identify: (req) => {
        const body = req.body as { username?: unknown } | undefined;
        return typeof body?.username === "string"
          ? { username: body.username }
          : undefined;
      },
      now: clock.now,
      logger: () => {},
    });
    await installSecurity(app, security, { logger: () => {} });
  }
  app.get("/", (_req, res) => res.send("home"));
  app.post(
    "/login",
    securityProfile("login"),
    uniformAuthResponse({ minResponseMs: 1 }),
    (_req, res) => res.status(401).json({ error: "wrong password" }),
  );
  /** Runs `attack` against this app, moving its clock. */
  const run = (attack: Attack) =>
    runAttack(attack, fetchTarget(app), {
      advance: clock.advance,
      settle: () => Bun.sleep(0),
    });
  return { run, close: () => security?.close() };
}

const defended = await myApp(true);
const open = await myApp(false);

/* ------------------------------------------------------------------ */
step("credential stuffing: 100 leaked pairs from one address, one every 3 s");
const stuffing = credentialStuffing({
  path: "/login",
  count: 100,
  everyMs: 3000,
});
const stuffed = await defended.run(stuffing);
show("defended", {
  firstRefused: stuffed.firstRefused,
  byStatus: stuffed.byStatus,
});
checkEqual("stopped at the 10th distinct username", stuffed.firstRefused, 10);
const stuffedOpen = await open.run(stuffing);
checkEqual("negative control: every pair tried", stuffedOpen.refused, 0);

/* ------------------------------------------------------------------ */
step("path scanning: the probe paths, then 150 dead links, 20 a second");
const scan = paced(pathScan({ count: 150 }), 50);
const scanned = await defended.run(scan);
show("defended", { firstRefused: scanned.firstRefused, codes: scanned.codes });
checkEqual("refused from the first probe", scanned.firstRefused, 0);
checkEqual(
  "…and nothing answered after it",
  scanned.refused,
  PROBE_PATHS.length + 150,
);
const scannedOpen = await open.run(scan);
checkEqual("negative control: every probe answered", scannedOpen.refused, 0);

/* ------------------------------------------------------------------ */
step("a spoofed Googlebot");
const spoofed = await defended.run(
  spoofedCrawler({ client: "203.0.113.70", paths: ["/"] }),
);
checkEqual("blocked", spoofed.byStatus, { "403": 1 });
checkEqual(
  "negative control: served",
  (await open.run(spoofedCrawler({ client: "203.0.113.70", paths: ["/"] })))
    .byStatus,
  {
    "200": 1,
  },
);

defended.close();
summary();
