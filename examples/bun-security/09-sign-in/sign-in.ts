/**
 * Sign-in protection: answers that do not tell a missing account from a
 * wrong password, progressive delays and a challenge per attempted username,
 * device cookies that keep the owner in, and the `step-up` tag when one
 * account fails from many addresses.
 *
 * ```bash
 * bun 09-sign-in/sign-in.ts
 * ```
 *
 * - Mark the route `securityProfile("login")` and say who is being tried in
 *   `identify()` (`{ username }`); the engine keys usernames by their HMAC
 *   under `secret`, never in clear. A `401`/`403` answer counts as a failure
 *   and a `2xx` as a success unless the app signals one itself.
 * - `uniformAuthResponse({ minResponseMs })` makes every failure one `401`
 *   problem ("Login failed") held to a minimum time.
 * - Per username: after 5 failures each attempt waits (1 s, then 2 s; 200 ms
 *   at most here, `maxDelay`), at 10 a challenge (`429` with no challenge
 *   flow), at 20 a soft lock; a request with a valid device cookie for the
 *   username counts apart, so the owner's known device keeps signing in.
 * - 10 distinct addresses failing one username tag its requests `step-up`,
 *   for the app to ask a second factor; a valid device cookie is not tagged.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "@kingsleyweb/bun-security";
import {
  installSecurity,
  requestSecurity,
  securityProfile,
  uniformAuthResponse,
} from "@kingsleyweb/bun-security/http";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("sign-in protection");

/** The accounts: a password and a second factor each. */
const ACCOUNTS = new Map([
  ["hank@acme.test", { password: "a long passphrase", otp: "112358" }],
]);

const security = createSecurity<BunRequest>({
  policy: { profiles: { login: { failures: { maxDelay: "200ms" } } } },
  secret: "an-example-secret-of-at-least-32-bytes!",
  identify: (req) => {
    const body = req.body as { username?: unknown } | undefined;
    return typeof body?.username === "string"
      ? { username: body.username }
      : undefined;
  },
  logger: () => {},
});

const app = new BunHttpAdapter(0, { logger: () => {} });
await installSecurity(app, security, { logger: () => {} });
const MIN_MS = 120;
app.post(
  "/login",
  securityProfile("login"),
  uniformAuthResponse({ minResponseMs: MIN_MS }),
  (req, res) => {
    const { username, password, otp } = req.body as {
      username: string;
      password: string;
      otp?: string;
    };
    const account = ACCOUNTS.get(username);
    if (account === undefined)
      return res.status(404).json({ error: "no such account" });
    if (account.password !== password)
      return res.status(401).json({ error: "wrong password" });
    // The engine's step-up tag: the password alone is not enough now.
    const stepUp =
      requestSecurity(req)?.decision?.tags.includes("step-up") === true;
    if (stepUp && otp !== account.otp)
      return res.status(401).json({ error: "second factor required" });
    return res.json({ ok: true });
  },
);

/** One sign-in attempt; its status, body, time and any device cookie set. */
async function attempt(
  client: string,
  body: Record<string, string>,
  cookie?: string,
) {
  const started = performance.now();
  const response = await app.fetch("/login", {
    method: "POST",
    remoteAddress: client,
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const device = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-bun-security-device="))
    ?.split(";")[0];
  return {
    status: response.status,
    body: text,
    ms: performance.now() - started,
    device,
  };
}

/* ------------------------------------------------------------------ */
step("a missing account and a wrong password answer alike");
const missing = await attempt("198.51.100.1", {
  username: "nobody@acme.test",
  password: "x",
});
const wrong = await attempt("198.51.100.1", {
  username: "hank@acme.test",
  password: "x",
});
show("missing", {
  status: missing.status,
  body: missing.body,
  ms: Math.round(missing.ms),
});
show("wrong", {
  status: wrong.status,
  body: wrong.body,
  ms: Math.round(wrong.ms),
});
checkEqual("the same status", missing.status, wrong.status);
checkEqual("the same body", missing.body, wrong.body);
check(
  "both held to the minimum time",
  missing.ms >= MIN_MS - 1 && wrong.ms >= MIN_MS - 1,
  [missing.ms, wrong.ms],
);

/* ------------------------------------------------------------------ */
step("the owner signs in on the office laptop: a device cookie");
const owner = await attempt("198.51.100.10", {
  username: "hank@acme.test",
  password: "a long passphrase",
});
checkEqual("signed in", owner.status, 200);
check("a device cookie issued", owner.device !== undefined, owner);

/* ------------------------------------------------------------------ */
step("someone guesses hank's password from 14 addresses");
const guesses = [];
for (let i = 0; i < 14; i++) {
  guesses.push(
    await attempt(`203.0.113.${i + 1}`, {
      username: "hank@acme.test",
      password: `guess-${i}`,
    }),
  );
}
show(
  "statuses",
  guesses.map((g) => g.status),
);
show(
  "times (ms)",
  guesses.map((g) => Math.round(g.ms)),
);
// The owner's success cleared the earlier failure, so the count starts at 0.
checkEqual(
  "10 failures, then a challenge (429) for the username",
  guesses.map((g) => g.status),
  [
    ...Array.from({ length: 10 }, () => 401),
    ...Array.from({ length: 4 }, () => 429),
  ],
);
check(
  "attempts 6 to 10 waited (200 ms here)",
  guesses.slice(5, 10).every((g) => g.ms >= 195),
  guesses.map((g) => Math.round(g.ms)),
);

/* ------------------------------------------------------------------ */
step("the owner's known device keeps working; a new device does not");
const laptop = await attempt(
  "198.51.100.10",
  { username: "hank@acme.test", password: "a long passphrase" },
  owner.device,
);
checkEqual(
  "the laptop, password only: signed in (no step-up for a known device)",
  laptop.status,
  200,
);
const phone = await attempt("198.51.100.11", {
  username: "hank@acme.test",
  password: "a long passphrase",
  otp: "112358",
});
checkEqual(
  "a new phone, even with the second factor: challenged",
  phone.status,
  429,
);

/* ------------------------------------------------------------------ */
step("unlock(): the operator lifts the username's challenge");
await security.unlock("hank@acme.test");
const noOtp = await attempt("198.51.100.11", {
  username: "hank@acme.test",
  password: "a long passphrase",
});
checkEqual(
  "the new phone, password only: refused (still tagged step-up)",
  noOtp.status,
  401,
);
const withOtp = await attempt("198.51.100.11", {
  username: "hank@acme.test",
  password: "a long passphrase",
  otp: "112358",
});
checkEqual("…with the second factor: signed in", withOtp.status, 200);

security.close();
summary();
