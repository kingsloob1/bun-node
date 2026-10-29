/**
 * `redundant()` over server drivers (plan §5.5): the conformance kit, with
 * its two-process pass, over two Postgres members (two table prefixes on the
 * `BUN_CACHE_TEST_POSTGRES_URL` server) and over Redis
 * (`BUN_CACHE_TEST_REDIS_URL`) with Postgres behind it.
 *
 * The backends' rules (`backends.ts`): an unset URL skips visibly, a set but
 * unreachable one fails, naming its variable. Test data: this run's own
 * tables (`bun_cache_test_<pid>_…`) and Redis keys
 * (`bun-cache-test:<pid>-<time>:…`), dropped by name at the end.
 */
import process from "node:process";
import { afterAll } from "bun:test";
import { runCacheDriverConformance } from "../../lib/testing/index";
import type { RawChunk, SqlBackend } from "./backends";
import {
  deleteRedisPrefix,
  dropTables,
  reachError,
  redisBackend,
  redisRawDump,
  redisReachError,
  runPrefix,
  sqlBackends,
  sqlRawDump,
} from "./backends";
import type { RedundantMemberSpec, RedundantSpec } from "./redundant-fixture";
import { redundantFromSpec } from "./redundant-fixture";
import { reportNotConfigured, reportUnreachable } from "./sqlSuite";

const postgres = sqlBackends().find((each) => each.name === "postgres")!;
const redis = redisBackend();

/** The tables and keys this run created, dropped by name at the end. */
const tablePrefixes = new Set<string>();
const redisPrefixes = new Set<string>();
const redisRun = `bun-cache-test:${process.pid}-${Date.now().toString(36)}`;

afterAll(async () => {
  for (const prefix of tablePrefixes) {
    await dropTables(postgres, prefix);
  }
  for (const prefix of redisPrefixes) {
    await deleteRedisPrefix(redis.url!, prefix);
  }
});

/** A Postgres member on a table prefix of this run's. */
function pgMember(suffix: string): RedundantMemberSpec {
  const prefix = runPrefix(`redundant_${suffix}_`);
  tablePrefixes.add(prefix);
  return { kind: "postgres", url: postgres.url!, prefix };
}

/** A Redis member on a key prefix of this run's. */
function redisMember(suffix: string): RedundantMemberSpec {
  const prefix = `${redisRun}:${suffix}`;
  redisPrefixes.add(prefix);
  return { kind: "redis", url: redis.url!, prefix };
}

/** Everything every member stored, read around the drivers. */
async function dump(
  members: readonly RedundantMemberSpec[],
  backend: SqlBackend,
): Promise<RawChunk[]> {
  const out: RawChunk[] = [];
  for (const member of members) {
    out.push(
      ...(member.kind === "postgres"
        ? await sqlRawDump(backend, member.prefix)
        : await redisRawDump(member.url, member.prefix)),
    );
  }
  return out;
}

/** Runs the kit over one combinator, and in its two-process pass, a twin in a child. */
async function lane(title: string, spec: RedundantSpec): Promise<void> {
  const driver = redundantFromSpec(spec);
  await driver.connect!();
  await runCacheDriverConformance(
    title,
    () => ({
      driver,
      cleanup: async () => await driver.close(),
      rawDump: async () => await dump(spec.members, postgres),
    }),
    {
      crossProcess: {
        module: new URL("./redundant-fixture.ts", import.meta.url).pathname,
        export: "redundantFromSpec",
        options: spec,
      },
    },
  );
}

// Generous member timeouts: a loaded run (16 workers) must not read as a
// member going down and dirty, which would empty it mid-case.
const options = { timeout: 5_000 } as const;

const postgresMissing =
  postgres.url === undefined ? undefined : await reachError(postgres);
if (postgres.url === undefined) {
  reportNotConfigured("postgres (redundant)", postgres.variable);
} else if (postgresMissing !== undefined) {
  reportUnreachable("postgres (redundant)", postgres.variable, postgresMissing);
} else {
  await lane("redundant([postgres, postgres])", {
    members: [pgMember("a"), pgMember("b")],
    options,
  });
  if (redis.url === undefined) {
    reportNotConfigured("redis (redundant)", redis.variable);
  } else {
    const redisMissing = await redisReachError(redis.url);
    if (redisMissing === undefined) {
      await lane("redundant([redis, postgres])", {
        members: [redisMember("r"), pgMember("c")],
        options,
      });
    } else {
      reportUnreachable("redis (redundant)", redis.variable, redisMissing);
    }
  }
}
