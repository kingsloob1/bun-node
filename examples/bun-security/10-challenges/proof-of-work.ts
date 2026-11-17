/**
 * Challenges with the built-in proof of work: a challenged client proves
 * it spent some CPU, gets a clearance, and passes challenges with it.
 *
 * ```bash
 * bun 10-challenges/proof-of-work.ts
 * ```
 *
 * - Any `challenge` (a list entry's, a counted rule's, the ladder's first
 *   step, a request rule's, the bot signals') goes through the engine's
 *   challenge flow, `challenges({ provider, secret })`. Without a flow a
 *   challenge is a `block`.
 * - An API client gets `403` problem+json, `code: "challenge_required"`, with
 *   `challenge: { provider, field, path, data }`. It posts `{ answer }` as
 *   JSON to `path` and gets `{ clearance, header }`, then sends the token in
 *   `x-security-clearance`. A browser gets a page and a cookie instead.
 * - `powChallenge` is ALTCHA's v1 wire format (its widget can solve it);
 *   `solvePowChallenge()` solves one in Bun, as a test or a script would.
 *   An answer is single use; a clearance is bound to the client's network
 *   and User-Agent, valid 30 minutes.
 * - A clearance passes challenges, never blocks or bans.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "@kingsleyweb/bun-security";
import {
  challenges,
  powChallenge,
  solvePowChallenge,
} from "@kingsleyweb/bun-security/challenge";
import type { PowChallengeData } from "@kingsleyweb/bun-security/challenge";
import { installSecurity } from "@kingsleyweb/bun-security/http";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("challenges: proof of work");

const security = createSecurity<BunRequest>({
  policy: {
    lists: [
      // A network that has misbehaved before: challenge it, do not block it.
      { ip: "203.0.113.0/24", action: "challenge" },
      { ip: "198.51.100.66", action: "block" },
    ],
  },
  challenge: challenges({
    // Easy, for an example: the default is 50,000 tries at risk 0.
    provider: powChallenge({
      secret: "a-proof-of-work-secret-32-bytes-long!",
      maxNumber: 2000,
    }),
    secret: "a-clearance-signing-secret-of-32-bytes!",
  }),
  logger: () => {},
});

const app = new BunHttpAdapter(0, { logger: () => {} });
await installSecurity(app, security, { logger: () => {} });
app.get("/api/orders", (_req, res) => res.json({ orders: [] }));

const CLIENT = "203.0.113.30";
const UA = "orders-sync/2.1";

/** A request from `client`, as an API client (JSON). */
const call = (
  path: string,
  client: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
) =>
  app.fetch(path, {
    remoteAddress: client,
    method: init.method ?? "GET",
    headers: { accept: "application/json", "user-agent": UA, ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
  });

/* ------------------------------------------------------------------ */
step("a challenged client is asked to solve a puzzle");
const asked = await call("/api/orders", CLIENT);
const problem = (await asked.json()) as {
  code: string;
  challenge: {
    provider: string;
    field: string;
    path: string;
    data: PowChallengeData;
  };
};
show("the problem", {
  status: asked.status,
  code: problem.code,
  provider: problem.challenge.provider,
  path: problem.challenge.path,
});
checkEqual(
  "403 challenge_required",
  [asked.status, problem.code],
  [403, "challenge_required"],
);

/* ------------------------------------------------------------------ */
step("it solves it, and posts the answer for a clearance");
const started = performance.now();
const solved = solvePowChallenge(problem.challenge.data);
show("solved in (ms)", Math.round(performance.now() - started));
check("a solution found", solved !== undefined);
const answered = await call(problem.challenge.path, CLIENT, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ answer: solved }),
});
const cleared = (await answered.json()) as {
  clearance: string;
  header: string;
};
checkEqual(
  "200 with a clearance",
  [answered.status, cleared.header],
  [200, "x-security-clearance"],
);

/* ------------------------------------------------------------------ */
step("with the clearance it passes; without it, it is asked again");
const passed = await call("/api/orders", CLIENT, {
  headers: { [cleared.header]: cleared.clearance },
});
checkEqual("passes", passed.status, 200);
const again = await call("/api/orders", CLIENT);
await again.body?.cancel();
checkEqual("without the header: challenged again", again.status, 403);

/* ------------------------------------------------------------------ */
step("an answer is single use; a clearance is bound to its client");
const replayed = await call(problem.challenge.path, CLIENT, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ answer: solved }),
});
await replayed.body?.cancel();
check(
  "the same answer twice is refused",
  replayed.status !== 200,
  replayed.status,
);
const otherNetwork = await call("/api/orders", "203.0.113.200", {
  headers: { [cleared.header]: cleared.clearance },
});
await otherNetwork.body?.cancel();
checkEqual(
  "the token from the same /24 still passes",
  otherNetwork.status,
  200,
);
const otherAgent = await app.fetch("/api/orders", {
  remoteAddress: CLIENT,
  headers: {
    accept: "application/json",
    "user-agent": "curl/8",
    [cleared.header]: cleared.clearance,
  },
});
await otherAgent.body?.cancel();
checkEqual("…but not with another User-Agent", otherAgent.status, 403);

/* ------------------------------------------------------------------ */
step("a clearance never lifts a block");
const blocked = await call("/api/orders", "198.51.100.66", {
  headers: { [cleared.header]: cleared.clearance },
});
await blocked.body?.cancel();
checkEqual("a blocked address stays blocked", blocked.status, 403);

security.close();
summary();
