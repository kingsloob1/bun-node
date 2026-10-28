/**
 * The Redis driver (plan §7.7) against Upstash, the managed Redis, over TCP
 * and TLS (`rediss://…upstash.io`): the same kit and specifics as the local
 * server (`redisSuite.ts`), in the Upstash lane. **Opt-in**: it runs only when
 * `BUN_CACHE_TEST_UPSTASH_REDIS_URL` is set — never in a committed file, it
 * is a credential — and otherwise skips visibly. A set URL that cannot be
 * reached fails, naming the variable.
 *
 * What the lane changes, all measured (docs/plans/bun-cache/evidence/
 * upstash-spike.md): a round trip is ~300 ms from where the spike ran, so
 * every test may take 120 s and the short TTLs are 3 s; Upstash has no
 * `CLIENT KILL`, so the bus gap is a `QUIT` on the subscriber connection; its
 * `PEXPIRETIME` reads a few ms off the `PEXPIREAT` sent, so expiry is checked
 * within 100 ms; and the fence race runs 20 rounds, not 60.
 *
 * Upstash bills each command (a Lua script as one plus each `redis.call`
 * inside), so run this lane deliberately, not in every gate. Its keys are
 * this run's prefix, deleted at the end like the local lane's.
 */
import process from "node:process";
import { setDefaultTimeout } from "bun:test";
import { redisReachError } from "./backends";
import { registerRedisSuite } from "./redisSuite";
import { reportNotConfigured, reportUnreachable } from "./sqlSuite";

/** The variable that names the Upstash database. */
const VARIABLE = "BUN_CACHE_TEST_UPSTASH_REDIS_URL";

const url = process.env[VARIABLE] || undefined;
if (url === undefined) {
  reportNotConfigured(
    "upstash",
    VARIABLE,
    "a rediss://…upstash.io URL from the Upstash console; opt-in, never committed",
  );
} else {
  setDefaultTimeout(120_000);
  const unreachable = await redisReachError(url);
  if (unreachable !== undefined) {
    reportUnreachable("upstash", VARIABLE, unreachable);
  } else {
    await registerRedisSuite(url, {
      name: "upstash",
      busGap: "quit",
      expiryToleranceMs: 100,
      shortTtlMs: 3_000,
      raceRounds: 20,
    });
  }
}
