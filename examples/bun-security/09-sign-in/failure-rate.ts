/**
 * The global failure-rate rule: a password spray from a fresh address per
 * attempt, which no per-address or per-username rule sees, caught by the
 * sign-in route's failure ratio against its own baseline.
 *
 * ```bash
 * bun 09-sign-in/failure-rate.ts
 * ```
 *
 * - The `login.failure-rate` preset is on in every policy, **in dry run**: it
 *   counts every sign-in outcome of a route marked `login`, trips when at
 *   least 20 of the last 5 minutes' attempts failed at 3 × the route's usual
 *   failure ratio, records what it would answer (`log` hits) and raises the
 *   `login.failure-rate` warning. `presets: { "login.failure-rate": "enforce" }`
 *   answers.
 * - While tripped it answers sign-ins from a hosting address or a new
 *   device: a challenge (a `429` with no challenge flow), `step-up`, or a
 *   stricter limit, as `profiles.login.failureRate.respond` says. A valid
 *   device cookie for the username is never answered, so the owner's known
 *   device keeps signing in.
 * - `security.status().loginFailureRate` shows each route's ratio and
 *   baseline. Its counts are kept in the shared store when there is one, so
 *   a fleet trips on the fleet's spray.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "@kingsleyweb/bun-security";
import type { SecurityWarning } from "@kingsleyweb/bun-security";
import {
  installSecurity,
  securityProfile,
  uniformAuthResponse,
} from "@kingsleyweb/bun-security/http";
import {
  fetchTarget,
  passwordSpraying,
  runAttack,
} from "@kingsleyweb/bun-security/testing";
import { check, checkEqual, summary } from "../shared/check";
import { fakeClock } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("the global failure-rate rule");

/** The one real account. */
const OWNER = { username: "hank@acme.test", password: "a long passphrase" };

/** A sign-in app on an engine with the rule switched as given, on a fake clock. */
async function signInApp(setting: true | "enforce" | false) {
  const clock = fakeClock();
  const warnings: SecurityWarning[] = [];
  const security = createSecurity<BunRequest>({
    policy: { presets: { "login.failure-rate": setting } },
    secret: "an-example-secret-of-at-least-32-bytes!",
    identify: (req) => {
      const body = req.body as { username?: unknown } | undefined;
      return typeof body?.username === "string"
        ? { username: body.username }
        : undefined;
    },
    onWarning: (warning) => warnings.push(warning),
    now: clock.now,
    logger: () => {},
  });
  const app = new BunHttpAdapter(0, { logger: () => {} });
  await installSecurity(app, security, { logger: () => {} });
  app.post(
    "/login",
    securityProfile("login"),
    uniformAuthResponse({ minResponseMs: 1 }),
    (req, res) => {
      const { username, password } = req.body as Record<string, string>;
      return username === OWNER.username && password === OWNER.password
        ? res.json({ ok: true })
        : res.status(401).json({ error: "wrong password" });
    },
  );
  /** One sign-in from `client`: its status and any device cookie set. */
  const signIn = async (client: string, password: string, cookie?: string) => {
    const response = await app.fetch("/login", {
      method: "POST",
      remoteAddress: client,
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify({ username: OWNER.username, password }),
    });
    await response.text();
    const device = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-bun-security-device="))
      ?.split(";")[0];
    return { status: response.status, device };
  };
  // 60 accounts, one password, a new address each time, one every 2 s.
  const spray = passwordSpraying({
    path: "/login",
    usernames: Array.from({ length: 60 }, (_, i) => `staff${i}@acme.test`),
    clients: 60,
    everyMs: 2000,
  });
  const run = () =>
    runAttack(spray, fetchTarget(app), {
      advance: clock.advance,
      settle: () => Bun.sleep(0),
    });
  return { security, warnings, signIn, run };
}

/* ------------------------------------------------------------------ */
step("off: a fresh address per attempt passes every per-key rule");
const off = await signInApp(false);
const unseen = await off.run();
show("answered", unseen.byStatus);
checkEqual("all 60 reached the password check", unseen.byStatus, { "401": 60 });

/* ------------------------------------------------------------------ */
step(
  "as it ships: dry run, every attempt answered, the spray recorded and warned of",
);
const shipped = await signInApp(true);
const recorded = await shipped.run();
await shipped.security.flush();
const [state] = shipped.security.status().loginFailureRate ?? [];
show("route", {
  route: state?.route,
  tripped: state?.tripped,
  failures: state?.failures,
  ratio: state?.ratio,
});
checkEqual("every attempt answered", recorded.byStatus, { "401": 60 });
check("the route is tripped", state?.tripped === true, state);
checkEqual(
  "warned once",
  shipped.warnings.filter((w) => w.kind === "login.failure-rate").length,
  1,
);

/* ------------------------------------------------------------------ */
step(
  "enforced: the owner's known device signs in; the spray past its 20th failure does not",
);
const enforced = await signInApp("enforce");
// The owner signs in once, before the spray, and holds a device cookie.
const first = await enforced.signIn("203.0.113.9", OWNER.password);
checkEqual("the owner signs in", first.status, 200);
const stopped = await enforced.run();
show("spray", {
  byStatus: stopped.byStatus,
  firstRefused: stopped.firstRefused,
});
checkEqual("20 failures reach the password check, then 429", stopped.byStatus, {
  "401": 20,
  "429": 40,
});
const newDevice = await enforced.signIn("192.0.2.10", OWNER.password);
checkEqual(
  "the right password from a new device: challenged (429 here)",
  newDevice.status,
  429,
);
const knownDevice = await enforced.signIn(
  "192.0.2.10",
  OWNER.password,
  first.device,
);
checkEqual(
  "the same from the owner's known device: signed in",
  knownDevice.status,
  200,
);

summary();
