/**
 * The Redis driver (plan §7.7) on the local server `BUN_CACHE_TEST_REDIS_URL`
 * (or `BUN_JOBS_TEST_REDIS_URL`) names: database 15, the repository's test
 * database (`bun scripts/setup-databases.ts --print-env`). The suite itself is
 * `redisSuite.ts`, shared with the opt-in Upstash lane (`upstash.test.ts`).
 *
 * A backend whose URL is unset skips visibly; one whose URL is set but
 * unreachable fails, naming the variable.
 */
import { redisBackend, redisReachError } from "./backends";
import { registerRedisSuite } from "./redisSuite";
import { reportNotConfigured, reportUnreachable } from "./sqlSuite";

const redis = redisBackend();
if (redis.url === undefined) {
  reportNotConfigured("redis", redis.variable);
} else {
  const unreachable = await redisReachError(redis.url);
  if (unreachable !== undefined) {
    reportUnreachable("redis", redis.variable, unreachable);
  } else {
    await registerRedisSuite(redis.url);
  }
}
