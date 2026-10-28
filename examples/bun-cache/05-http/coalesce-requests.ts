/**
 * `coalesceRequests()` alone — identical in-flight GETs share one handler run,
 * with no store: nothing is kept once the burst is answered.
 *
 * ```bash
 * bun 05-http/coalesce-requests.ts
 * ```
 *
 * - Five concurrent GETs run the handler once; each follower gets a copy of
 *   the leader's buffered answer through its own response.
 * - A request carrying a `Cookie` (or `Authorization`) runs on its own unless
 *   your `key` includes the identity.
 * - An answer that sets a cookie is not shared either.
 * - After the burst nothing is cached: the next GET runs the handler again.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { coalesceRequests } from "@kingsleyweb/bun-cache/http";
import { check, checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";

title("bun-cache/http: coalesceRequests without a store");

const router = new BunRouter();
const runs = { report: 0, login: 0 };

router.get("/report", coalesceRequests(), async (_req, res) => {
  const run = ++runs.report;
  await Bun.sleep(100);
  res.send(`report ${run}`);
});
router.get("/login", coalesceRequests(), async (_req, res) => {
  const run = ++runs.login;
  await Bun.sleep(50);
  res.cookie("session", `s${run}`).send("welcome");
});

/** `count` concurrent GETs of `path` with `headers`; their bodies. */
async function burst(
  path: string,
  count: number,
  headers: Record<string, string> = {},
): Promise<string[]> {
  return await Promise.all(
    Array.from({ length: count }, async () => {
      return await (await router.fetch(path, { headers })).text();
    }),
  );
}

/* ------------------------------------------------------------------ */
step("five identical GETs");

const bodies = await burst("/report", 5);
checkEqual("the handler ran once", runs.report, 1);
check(
  "all five got its body",
  bodies.every((body) => body === "report 1"),
  bodies,
);

/* ------------------------------------------------------------------ */
step("requests with a Cookie run on their own");

const before = runs.report;
const cookied = await burst("/report", 3, { cookie: "user=ada" });
checkEqual("three runs", runs.report - before, 3);
checkEqual("three different bodies", new Set(cookied).size, 3);

/* ------------------------------------------------------------------ */
step("an answer that sets a cookie is not shared");

const sessions = await Promise.all(
  Array.from({ length: 3 }, async () => {
    const response = await router.fetch("/login");
    return response.headers.get("set-cookie");
  }),
);
check(
  "every caller got a cookie of its own",
  new Set(sessions).size === 3 && sessions.every((c) => c !== null),
  sessions,
);
checkEqual("the handler ran three times", runs.login, 3);

/* ------------------------------------------------------------------ */
step("nothing is stored");

const again = await burst("/report", 1);
checkEqual(
  "the next GET runs the handler again",
  again[0],
  `report ${runs.report}`,
);
check("…a new run", runs.report === before + 3 + 1, runs.report);

summary();
