/**
 * What counts, and how much is allowed, per request — express-rate-limit's
 * `skipSuccessfulRequests`, `skipFailedRequests`, `requestWasSuccessful` and
 * a `limit` function, on bun-common's `throttle()`.
 *
 * ```bash
 * bun 16-throttle/refunds.ts
 * ```
 *
 * - **`skipSuccessfulRequests`**: a sign-in that counts failed attempts
 *   only. Every request counts while it runs; once its response is sent, a
 *   successful one is given back. Ten good sign-ins pass, the third bad one
 *   in a row is refused, and the refusal locks out the right password too.
 * - **`skipFailedRequests`**: an expensive export that counts the exports
 *   that worked. A failure is given back, and so is a refusal (a `429` is a
 *   failure), so a client that keeps asking is not held back by its own
 *   refusals.
 * - **`requestWasSuccessful`**: what success means. Here a `404` is a
 *   success (a lookup that found nothing is not an attack), only `5xx` fail.
 * - **`limit(req)`**: the quota per request: three for a `pro` account, one
 *   for the rest, through one throttle. The document calls it `"dynamic"`;
 *   the `RateLimit-Policy` header carries the quota that applied.
 * - Under **GCRA** a success gives its token back and a refusal, which took
 *   nothing, gets nothing.
 *
 * Every count runs on a fake clock aligned to a minute, so the windows hold
 * still.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import { BunRouter, throttle } from "@kingsleyweb/bun-common";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Refunds and per-request limits");

const T0 = 60_000 * 29_000_000;
let time = T0 + 1_000;
const now = (): number => time;
const byClient = (req: BunRequest): string => req.get("x-client") ?? "anon";

/** Requests `path` `n` times as `client` and answers each status. */
async function statuses(
  router: BunRouter,
  path: string,
  n: number,
  client = "alice",
  headers: Record<string, string> = {},
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await router.fetch(path, {
      headers: { "x-client": client, ...headers },
    });
    out.push(res.status);
  }
  return out;
}

/* ------------------------------------------------------------------ */
step("skipSuccessfulRequests: a sign-in that counts failures only");

const signIn = new BunRouter();
signIn.get(
  "/sign-in",
  throttle({
    limit: 3,
    window: "15m",
    key: byClient,
    skipSuccessfulRequests: true,
    now,
  }),
  (req, res) => {
    if (req.get("x-password") === "right") res.send("welcome");
    else res.status(401).send("no");
  },
);
const right = { "x-password": "right" };
checkEqual(
  "ten good sign-ins: none counts",
  await statuses(signIn, "/sign-in", 10, "alice", right),
  Array.from({ length: 10 }, () => 200),
);
checkEqual(
  "three bad ones: the third reaches the limit, the fourth is refused",
  await statuses(signIn, "/sign-in", 4),
  [401, 401, 401, 429],
);
checkEqual(
  "the right password is refused too while the limit holds",
  await statuses(signIn, "/sign-in", 1, "alice", right),
  [429],
);
checkEqual(
  "another client is untouched",
  await statuses(signIn, "/sign-in", 1, "bob", right),
  [200],
);

/* ------------------------------------------------------------------ */
step("skipFailedRequests: an export that counts what worked");

/** An hour's start, for the hour-long window below. */
const HOUR0 = Math.ceil(T0 / 3_600_000) * 3_600_000;
time = HOUR0 + 1_000;
let healthy = false;
const exporter = new BunRouter();
exporter.get(
  "/export",
  throttle({
    limit: 2,
    window: "1h",
    key: byClient,
    skipFailedRequests: true,
    now,
  }),
  (_req, res) => {
    if (healthy) res.send("csv");
    else res.status(503).send("try later");
  },
);
checkEqual(
  "the backend is down: five failures, none counts",
  await statuses(exporter, "/export", 5),
  [503, 503, 503, 503, 503],
);
healthy = true;
checkEqual(
  "back up: two exports, then refused",
  await statuses(exporter, "/export", 3),
  [200, 200, 429],
);
checkEqual(
  "refusals are failures, given back: still refused, never further behind",
  await statuses(exporter, "/export", 3),
  [429, 429, 429],
);
time = HOUR0 + 3_600_000 + 45 * 60_000;
checkEqual(
  "45 min into the next hour the last hour's 2 weigh a quarter: one fits (had the refusals counted, 5 would weigh 1.25, and none would)",
  await statuses(exporter, "/export", 2),
  [200, 429],
);

/* ------------------------------------------------------------------ */
step("requestWasSuccessful: a 404 is a success here");

const lookup = new BunRouter();
lookup.get(
  "/users/:id",
  throttle({
    limit: 2,
    key: byClient,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode < 500,
    now,
  }),
  (req, res) => {
    if (req.params.id === "boom") res.status(500).send("broken");
    else res.status(404).send("no such user");
  },
);
checkEqual(
  "five lookups that found nothing: none counts",
  await statuses(lookup, "/users/42", 5),
  [404, 404, 404, 404, 404],
);
checkEqual(
  "server errors count",
  await statuses(lookup, "/users/boom", 3),
  [500, 500, 429],
);

/* ------------------------------------------------------------------ */
step("limit(req): a quota per account");

const tiered = throttle({
  limit: (req) => (req.get("x-plan") === "pro" ? 3 : 1),
  window: "1m",
  key: byClient,
  headers: "ietf",
  now,
});
const api = new BunRouter({ throttle: tiered });
api.get("/report", (_req, res) => {
  res.send("report");
});
checkEqual(
  "a pro account: three",
  await statuses(api, "/report", 4, "pat", { "x-plan": "pro" }),
  [200, 200, 200, 429],
);
checkEqual(
  "a free account: one",
  await statuses(api, "/report", 2, "fred"),
  [200, 429],
);
const head = await api.fetch("/report", {
  headers: { "x-client": "pam", "x-plan": "pro" },
});
show(
  `RateLimit-Policy for a pro account: ${head.headers.get("RateLimit-Policy")}`,
);
checkEqual(
  "the header carries the quota that applied",
  head.headers.get("RateLimit-Policy"),
  '"default";q=3;w=60',
);
checkEqual(
  "the policy, as documents show it",
  tiered.policies.map((policy) => policy.limit),
  ["dynamic"],
);

/* ------------------------------------------------------------------ */
step("GCRA: a success gives its token back, a refusal had none");

time = T0;
const bucket = new BunRouter();
bucket.get(
  "/search",
  throttle({
    limit: 2,
    window: "10s",
    algorithm: "gcra",
    key: byClient,
    skipSuccessfulRequests: true,
    now,
  }),
  (req, res) => {
    if (req.get("x-query") === "") res.status(400).send("empty");
    else res.send("results");
  },
);
const empty = { "x-query": "" };
checkEqual(
  "good searches give their tokens back",
  await statuses(bucket, "/search", 5, "alice", { "x-query": "bun" }),
  [200, 200, 200, 200, 200],
);
checkEqual(
  "bad ones keep theirs: two, then the bucket is empty",
  await statuses(bucket, "/search", 3, "alice", empty),
  [400, 400, 429],
);
time += 5_000;
checkEqual(
  "5 s later one token is back",
  await statuses(bucket, "/search", 2, "alice", empty),
  [400, 429],
);

summary();
