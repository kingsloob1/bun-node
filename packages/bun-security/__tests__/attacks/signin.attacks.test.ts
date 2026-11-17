/**
 * Sign-in attacks against ConcaveHR's request path (plan §11.2, §12; layers.md
 * L11), each with its negative control, the same app with no engine, where
 * the attack succeeds. T-L11-1 (credential stuffing: one address × 1,000
 * usernames, 1,000 addresses × one username, low and slow over six hours),
 * T-L11-2 (enumeration by status, body and time), T-L11-3 (locking the
 * victim out), and password spraying from a pool of addresses.
 */
import { describe, expect, it } from "bun:test";
import type { Attack } from "../../lib/testing/index";
import {
  accountEnumeration,
  credentialStuffing,
  distributedGuessing,
  enumerationLeaks,
  lowAndSlow,
  passwordSpraying,
  probeAnswers,
} from "../../lib/testing/index";
import { ACCOUNTS, concaveApp, SECOND_FACTORS } from "./app";
import type { ConcaveApp } from "./app";

const LOGIN = "/auth/login";
const ALICE = "alice@concave.example.org";
const HANK = "hank@concave.example.org";

/** `attack` with request `index` replaced by a sign-in with `username`'s real password: the pair that takes the account over. */
function withRealPair(attack: Attack, index: number, username: string): Attack {
  const requests = [...attack.requests];
  const original = requests[index];
  requests[index] = {
    ...original,
    body: JSON.stringify({ username, password: ACCOUNTS.get(username) }),
  };
  return { name: attack.name, requests };
}

/**
 * Signs in as `username` with the real password from `client`, with the
 * device `cookie` and the account's second factor when given; the answer's
 * status, the device cookie it set, and whether the engine tagged any of
 * its decisions `step-up`.
 */
async function ownerSignIn(
  app: ConcaveApp,
  username: string,
  client: string,
  options: { readonly cookie?: string; readonly secondFactor?: boolean } = {},
) {
  const { cookie } = options;
  const mark = app.decisions.length;
  const response = await app.target({
    method: "POST",
    path: LOGIN,
    client,
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({
      username,
      password: ACCOUNTS.get(username),
      ...(options.secondFactor === true
        ? { secondFactor: SECOND_FACTORS.get(username) }
        : {}),
    }),
  });
  await response.text();
  const device = response.headers
    .getSetCookie()
    .find((header) => header.startsWith("__Host-bun-security-device="))
    ?.split(";")[0];
  const stepUp = app.decisions
    .slice(mark)
    .some(({ decision }) => decision.tags.includes("step-up"));
  return { status: response.status, device, stepUp };
}

describe("T-L11-1: credential stuffing, one address × 1,000 usernames", () => {
  // One attempt every 3 s: under login.ip's 30 a minute, so the detector,
  // not the rate limit, is what stops it.
  const attack = withRealPair(
    credentialStuffing({ path: LOGIN, count: 1000, everyMs: 3000 }),
    500,
    ALICE,
  );

  it("challenge-bans the address at its 10th distinct failing username; the leaked pair at #500 never reaches the app", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    expect(result.sent).toBe(1000);
    expect(result.firstRefused).toBe(10);
    // The challenge ban lasts 15 minutes (with no challenge flow it blocks);
    // each attempt after it ends trips it again, as the distinct count is
    // still over 10 in the hour: 10, then one per 15 minutes (#309, #609,
    // #909) over the run's 50 minutes.
    expect(result.byStatus).toEqual({ "401": 13, "403": 987 });
    expect(
      result.statuses.flatMap((status, i) =>
        status === 401 && i >= 10 ? [i] : [],
      ),
    ).toEqual([309, 609, 909]);
    expect(result.codes).toEqual({ banned: 987 });
    expect(result.statuses[500]).toBe(403);
    expect(app.security?.bans().map((ban) => [ban.id, ban.rule])).toEqual([
      ["ip:203.0.113.66", "login:distinct-usernames"],
    ]);
  });

  it("negative control: with no engine every pair is tried and #500 takes the account", async () => {
    const result = await (await concaveApp({ defences: false })).run(attack);
    expect(result.refused).toBe(0);
    expect(result.byStatus).toEqual({ "200": 1, "404": 999 });
    expect(result.statuses[500]).toBe(200);
  });
});

describe("T-L11-1 and T-L11-3: 1,000 addresses × one username, and the victim's own device", () => {
  const attack = withRealPair(
    distributedGuessing({
      path: LOGIN,
      username: HANK,
      count: 1000,
      everyMs: 3000,
    }),
    900,
    HANK,
  );

  it("delays, then challenges the username from every untrusted device, tags step-up; the owner's device still signs in", async () => {
    const app = await concaveApp();
    // The owner signs in from the office before the attack: a device cookie.
    const before = await ownerSignIn(app, HANK, "198.51.100.10");
    expect(before.status).toBe(200);
    expect(before.device).toBeDefined();

    const result = await app.run(attack);
    // Ten failures per 15-minute failure window reach the app, then the
    // username is challenged (429 with no flow): 40 over the run's 50 minutes.
    expect(result.firstRefused).toBe(10);
    expect(result.byStatus).toEqual({ "401": 40, "429": 960 });
    expect(result.codes).toEqual({ rate_limited: 960 });
    // #900, the right password, reached the app in a fresh window and was
    // refused for want of a second factor: the account is tagged step-up
    // (10 distinct addresses failed it). Nothing else answers it 401.
    expect(result.statuses[900]).toBe(401);
    const fired = app.fired();
    expect(fired).toContain("login:delay:delay");
    expect(fired).toContain("login:challenge:block");
    expect(
      app.decisions.some(({ decision }) => decision.tags.includes("step-up")),
    ).toBe(true);
    // No address is banned: each tried once, so banning one would only hurt
    // whoever has that address next.
    expect(app.security?.bans()).toEqual([]);

    // T-L11-3: the owner's known device keeps working, and its valid device
    // cookie skips the step-up tag: no second factor is asked of it.
    const owner = await ownerSignIn(app, HANK, "198.51.100.10", {
      cookie: before.device!,
    });
    expect(owner).toMatchObject({ status: 200, stepUp: false });
    // A device without the cookie, even with the right password and the
    // second factor, is throttled, and tagged step-up.
    const untrusted = await ownerSignIn(app, HANK, "198.51.100.11", {
      secondFactor: true,
    });
    expect(untrusted).toMatchObject({ status: 429, stepUp: true });
    // Another account is untouched.
    expect((await ownerSignIn(app, ALICE, "198.51.100.11")).status).toBe(200);
  });

  it("negative control: with no engine all 1,000 guesses are answered and #900 takes the account", async () => {
    const result = await (await concaveApp({ defences: false })).run(attack);
    expect(result.refused).toBe(0);
    expect(result.byStatus).toEqual({ "200": 1, "401": 999 });
    expect(result.statuses[900]).toBe(200);
  });
});

describe("T-L11-1: low and slow, one address over six hours", () => {
  // 72 attempts, one every 5 minutes: never two in a minute.
  const attack = lowAndSlow({ path: LOGIN, count: 72, hours: 6 });

  it("the distinct-usernames detector still fires within its hour", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    expect(result.firstRefused).toBe(10);
    expect(result.codes.banned).toBeGreaterThan(0);
    expect(app.security?.bans().map((ban) => ban.rule)).toEqual([
      "login:distinct-usernames",
    ]);
    // A per-minute limit alone never saw more than one.
    expect(app.fired().some((hit) => hit.startsWith("login.ip:"))).toBe(false);
  });

  it("negative control: with no engine all 72 are answered", async () => {
    const result = await (await concaveApp({ defences: false })).run(attack);
    expect(result.refused).toBe(0);
    expect(result.byStatus).toEqual({ "404": 72 });
  });
});

describe("password spraying: one password, 60 accounts, a pool of three addresses", () => {
  const usernames = Array.from(
    { length: 60 },
    (_, i) => `staff${i}@concave.example.org`,
  );
  const attack = passwordSpraying({
    path: LOGIN,
    usernames,
    clients: 3,
    everyMs: 2000,
  });

  it("bans each address of the pool at its 10th distinct username", async () => {
    const app = await concaveApp();
    const result = await app.run(attack);
    expect(result.byStatus).toEqual({ "401": 30, "403": 30 });
    expect(
      app.security
        ?.bans()
        .map((ban) => ban.id)
        .sort(),
    ).toEqual(["ip:203.0.0.1", "ip:203.0.0.2", "ip:203.0.0.3"]);
  });

  it("negative control: with no engine every account is tried", async () => {
    const result = await (await concaveApp({ defences: false })).run(attack);
    expect(result.byStatus).toEqual({ "404": 60 });
  });
});

describe("T-L11-2: enumeration by status, body and time", () => {
  const known = new Set([ALICE, "bob@concave.example.org"]);
  const attack = accountEnumeration({
    path: LOGIN,
    usernames: [
      ALICE,
      "nobody@concave.example.org",
      "bob@concave.example.org",
      "ghost@concave.example.org",
    ],
  });
  const MIN_MS = 150;

  it("uniformAuthResponse leaves nothing to tell a real account from a missing one", async () => {
    const app = await concaveApp({ minResponseMs: MIN_MS });
    const answers = await probeAnswers(attack, app.target);
    expect(answers.map((answer) => answer.status)).toEqual([
      401, 401, 401, 401,
    ]);
    // A millisecond of slack for timer granularity; the answers are held to MIN_MS.
    expect(enumerationLeaks(answers, known, MIN_MS - 1)).toEqual([]);
  });

  it("negative control: with no engine the status, the body and the time all tell", async () => {
    const app = await concaveApp({ defences: false });
    const answers = await probeAnswers(attack, app.target);
    expect(answers.map((answer) => answer.status)).toEqual([
      401, 404, 401, 404,
    ]);
    expect(enumerationLeaks(answers, known, MIN_MS - 1)).toEqual([
      "status",
      "body",
      "time",
    ]);
  });
});
