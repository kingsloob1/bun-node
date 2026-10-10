import type { JobsDriver } from "../lib/index";
import type { SummonGroupEntry } from "../lib/summon/group";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { BunQueue, createDriver } from "../lib/index";
import {
  isSummonGroupEntry,
  summonGroupRef,
  summonGroupStateName,
} from "../lib/summon/group";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { withinOneHour } from "./helpers/budgetWindow";
import { runBun } from "./helpers/spawnBun";

/**
 * A summon group under replica contention (review of #314, A1 and A2):
 * several processes each run a controller on the **same** queues, as
 * replicas of one service do. Of the replicas racing for one queue, one
 * claims and the rest lose — and each loser charged the group first.
 *
 * - A1: every loser's charge is given back, so the group counts exactly the
 *   calls made: no refund is lost to the other losers' refunds.
 * - A2: the losers' passing charges never make the group look spent while
 *   fewer calls than the limit were made: no queue is refused with `budget`,
 *   no `budget-exhausted` is told, and the group spends its whole limit.
 *
 * `summon-group-race.test.ts` runs one controller per queue, so it cannot
 * see either.
 */

setDefaultTimeout(300_000);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

const RACER = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "summon-group-racer.ts",
);
const BACKENDS = await crossProcessBackends({ cleanups });

/** Rounds per scenario, fewer with `SUMMON_GROUP_REPLICA_ROUNDS`. */
const ROUNDS = Number(process.env.SUMMON_GROUP_REPLICA_ROUNDS ?? 5);
/** Time between two rounds' starts, so a round is over before the next begins. */
const SLOT_MS = 1_500;
/** How long after the racers are given their start the rounds begin. */
const START_DELAY_MS = 4_000;
/**
 * How much of the UTC hour a race needs: every round, from the start, plus a
 * minute for slow process starts and checks on a loaded machine. A round
 * that straddles an hour counts in two windows, and one of a limit spends it
 * twice, so a race that would begin too near the hour's end waits for the
 * next one.
 */
const RACE_SPAN_MS = START_DELAY_MS + ROUNDS * SLOT_MS + 60_000;

/** One line a racer printed. */
interface RacerLine {
  round: number;
  queue: string;
  call?: string;
  action?: string;
  reason?: string | null;
  alert?: string;
}

/** Runs `replicas` racer processes, each with a controller on every queue of `queues`. */
async function race(
  backend: { config: unknown },
  options: {
    name: string;
    replicas: number;
    queues: readonly string[];
    perHour: number;
  },
): Promise<{
  lines: RacerLine[];
  entries: (SummonGroupEntry | undefined)[];
}> {
  const driver: JobsDriver = createDriver(backend.config as never);
  await driver.connect();
  const base = testNamespace(`group-replicas-${options.name}`);
  const namespaces = Array.from(
    { length: ROUNDS },
    (_, round) => `${base}-r${round}`,
  );
  try {
    for (const namespace of namespaces) {
      for (const name of options.queues) {
        const queue = new BunQueue(name, {
          namespace,
          driver,
          logger: noopLogger,
        });
        await queue.add("a", {});
        await queue.close();
      }
    }
    await withinOneHour(RACE_SPAN_MS);
    const env = {
      SUMMON_TEST_DRIVER: JSON.stringify(backend.config),
      SUMMON_TEST_NAMESPACES: namespaces.join(","),
      SUMMON_TEST_START_AT: String(Date.now() + START_DELAY_MS),
      SUMMON_TEST_SLOT_MS: String(SLOT_MS),
      SUMMON_TEST_PER_HOUR: String(options.perHour),
      SUMMON_TEST_CHECKS: "4",
      SUMMON_TEST_QUEUES: options.queues.join(","),
    };
    const runs = await Promise.all(
      Array.from(
        { length: options.replicas },
        async () => await runBun<RacerLine>(RACER, env),
      ),
    );
    for (const run of runs) {
      expect(run.exitCode, run.stderr).toBe(0);
    }
    // Read as stored, never rolled to now: a run crossing a UTC hour would
    // otherwise read the hour's count as 0.
    const entries = await Promise.all(
      namespaces.map(async (namespace) => {
        const stored = await driver.getQueueState!(
          summonGroupRef(namespace),
          summonGroupStateName("media"),
        );
        return isSummonGroupEntry(stored?.value)
          ? (stored.value as SummonGroupEntry)
          : undefined;
      }),
    );
    return { lines: runs.flatMap((run) => run.lines), entries };
  } finally {
    for (const namespace of namespaces) {
      await driver.purge(namespace).catch(() => {});
    }
    await driver.close();
  }
}

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `summon group replicas: ${backend.name}`,
    () => {
      it(`counts exactly the calls made when eight replicas race on two queues (${ROUNDS} rounds)`, async () => {
        const { lines, entries } = await race(backend, {
          name: `a1-${backend.name}`,
          replicas: 8,
          queues: ["q0", "q1"],
          perHour: 1000,
        });
        const counts = entries.map((entry, round) => {
          const calls = lines.filter(
            (line) => line.round === round && line.call !== undefined,
          ).length;
          const shares = Object.values(entry?.queues ?? {}).reduce(
            (sum, share) => sum + share.day,
            0,
          );
          return {
            round,
            calls,
            hour: entry?.budget.hour,
            day: entry?.budget.day,
            shares,
          };
        });
        expect(counts).toEqual(
          counts.map(({ round, calls }) => ({
            round,
            calls,
            hour: calls,
            day: calls,
            shares: calls,
          })),
        );
        // One call per queue: its job needs one worker.
        expect(counts.every(({ calls }) => calls === 2)).toBe(true);
      });

      it(`spends the whole limit with no false budget refusal when six replicas race on four queues (${ROUNDS} rounds)`, async () => {
        const perHour = 4;
        const { lines, entries } = await race(backend, {
          name: `a2-${backend.name}`,
          replicas: 6,
          queues: ["q0", "q1", "q2", "q3"],
          perHour,
        });
        // Four queues, one job each, a limit of four: every queue is served
        // and nothing ever reaches the limit with work left to refuse.
        const rounds = entries.map((entry, round) => {
          const mine = lines.filter((line) => line.round === round);
          return {
            round,
            calls: mine.filter((line) => line.call !== undefined).length,
            budgetSkips: mine.filter((line) => line.reason === "budget").length,
            alerts: mine.filter((line) => line.alert === "budget-exhausted")
              .length,
            hour: entry?.budget.hour,
          };
        });
        expect(rounds).toEqual(
          rounds.map(({ round }) => ({
            round,
            calls: perHour,
            budgetSkips: 0,
            alerts: 0,
            hour: perHour,
          })),
        );
      });
    },
  );
}
