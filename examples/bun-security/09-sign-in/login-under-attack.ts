/**
 * The login profile under attack: `./testing`'s credential-stuffing and
 * distributed-guessing simulators run against a sign-in route marked
 * `securityProfile("login")`, enforced, while the account's owner keeps
 * signing in on the device the engine knows. Each run has its negative
 * control: the same app with no engine, where every attempt is answered.
 *
 * ```bash
 * bun 09-sign-in/login-under-attack.ts
 * ```
 *
 * - Credential stuffing: one address trying 200 leaked pairs, one every 3 s.
 *   The login profile bans the address once it has failed on 10 distinct
 *   usernames (`403`, code `banned`); nothing past that is answered.
 * - Distributed guessing: 200 addresses each trying one password on the
 *   owner's account, one every 2 s, so no address is ever seen twice. The
 *   per-username count challenges the account after its 10th failure,
 *   whatever the address (`429`, code `rate_limited`, with no challenge flow
 *   configured).
 * - The owner signed in on the laptop before the attack and holds its device
 *   cookie: the laptop is counted apart and still signs in. A new device is
 *   challenged like the attacker until the attack stops.
 * - The engine runs on a fake clock that `runAttack` advances, so 10 minutes
 *   of attack take a moment; nothing here asserts on a duration.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "@kingsleyweb/bun-security";
import {
  installSecurity,
  securityProfile,
  uniformAuthResponse,
} from "@kingsleyweb/bun-security/http";
import {
  credentialStuffing,
  distributedGuessing,
  fetchTarget,
  runAttack,
} from "@kingsleyweb/bun-security/testing";
import type { Attack, AttackResult } from "@kingsleyweb/bun-security/testing";
import { check, checkEqual, summary } from "../shared/check";
import { fakeClock } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("the login profile under attack");

/** The one real account. */
const OWNER = { username: "hank@acme.test", password: "a long passphrase" };

/** A sign-in app, with the engine (`defended`) or without, on a fake clock. */
async function signInApp(defended: boolean) {
  const clock = fakeClock();
  const app = new BunHttpAdapter(0, { logger: () => {} });
  const security = defended
    ? createSecurity<BunRequest>({
        policy: {
          // The delays are real waits; kept short so 400 attempts take a moment.
          profiles: { login: { failures: { maxDelay: "5ms" } } },
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
      })
    : undefined;
  if (security !== undefined) {
    await installSecurity(app, security, { logger: () => {} });
  }
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
  /** One sign-in by the owner from `client`: its status and any device cookie set. */
  const owner = async (client: string, cookie?: string) => {
    const response = await app.fetch("/login", {
      method: "POST",
      remoteAddress: client,
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(OWNER),
    });
    await response.text();
    const device = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-bun-security-device="))
      ?.split(";")[0];
    return { status: response.status, device };
  };
  /** Runs `attack`, moving the clock to each request's time. */
  const run = (attack: Attack): Promise<AttackResult> =>
    runAttack(attack, fetchTarget(app), {
      advance: clock.advance,
      settle: () => Bun.sleep(0),
    });
  return { owner, run, close: () => security?.close() };
}

/** A run's outcome, for the log. */
const outcome = (result: AttackResult) => ({
  firstRefused: result.firstRefused,
  refused: result.refused,
  byStatus: result.byStatus,
  codes: result.codes,
});

const defended = await signInApp(true);
const open = await signInApp(false);

/* ------------------------------------------------------------------ */
step("before the attack, the owner signs in on the laptop");
const laptop = await defended.owner("198.51.100.10");
checkEqual("signed in", laptop.status, 200);
check("a device cookie issued", laptop.device !== undefined, laptop);

/* ------------------------------------------------------------------ */
step("credential stuffing: 200 leaked pairs from one address, one every 3 s");
const stuffing = credentialStuffing({ count: 200, everyMs: 3000 });
const stuffed = await defended.run(stuffing);
show("defended", outcome(stuffed));
checkEqual("refused from the 11th attempt on", stuffed.firstRefused, 10);
checkEqual("…and every attempt after it", stuffed.refused, 190);
checkEqual("the address banned", stuffed.codes, { banned: 190 });
const stuffedOpen = await open.run(stuffing);
checkEqual(
  "negative control: every pair tried and answered 401",
  stuffedOpen.byStatus,
  { "401": 200 },
);

/* ------------------------------------------------------------------ */
step("distributed guessing: 200 addresses, one guess each at hank's account");
const guessing = distributedGuessing({
  username: OWNER.username,
  count: 200,
  everyMs: 2000,
});
const guessed = await defended.run(guessing);
show("defended", outcome(guessed));
checkEqual("challenged from the 11th guess on", guessed.firstRefused, 10);
checkEqual("…and every guess after it", guessed.refused, 190);
checkEqual("the account challenged", guessed.codes, { rate_limited: 190 });
const guessedOpen = await open.run(guessing);
checkEqual("negative control: every guess answered 401", guessedOpen.byStatus, {
  "401": 200,
});

/* ------------------------------------------------------------------ */
step("the owner, during the attack");
checkEqual(
  "the laptop (its device cookie) still signs in",
  (await defended.owner("198.51.100.10", laptop.device)).status,
  200,
);
checkEqual(
  "a new phone is challenged like the attacker",
  (await defended.owner("198.51.100.11")).status,
  429,
);

defended.close();
summary();
