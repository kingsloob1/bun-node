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
import { SUMMON_MARKER } from "../lib/summon/marker";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { runBun } from "./helpers/spawnBun";

/**
 * The headline guarantee of a summon group's budget (plan summon-multi-queue
 * §7 (A) 1): eight controllers in four processes, one group allowing 5
 * attempts an hour, eight queues all given work at once — exactly 5 summoner
 * calls, never more, round after round, on every cross-process backend.
 *
 * Each round is its own namespace, so its group and markers start empty, and
 * every process starts it at the same instant (`summon-group-racer.ts`).
 */

setDefaultTimeout(240_000);

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

/** Rounds per backend: the plan's 20, or fewer with `SUMMON_GROUP_RACE_ROUNDS`. */
const ROUNDS = Number(process.env.SUMMON_GROUP_RACE_ROUNDS ?? 20);
/** The group's limit. */
const PER_HOUR = 5;
/** The queues, two per process. */
const QUEUES = ["q0", "q1", "q2", "q3", "q4", "q5", "q6", "q7"];
/** Time between two rounds' starts, so a round is over before the next begins. */
const SLOT_MS = 900;

/** One line a racer printed. */
interface RacerLine {
  round: number;
  queue: string;
  call?: string;
  action?: string;
  reason?: string | null;
}

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `summon group race: ${backend.name}`,
    () => {
      it(`eight controllers in four processes never summon past the group's limit (${ROUNDS} rounds)`, async () => {
        const driver: JobsDriver = createDriver(backend.config);
        await driver.connect();
        const base = testNamespace(`group-race-${backend.name}`);
        const namespaces = Array.from(
          { length: ROUNDS },
          (_, round) => `${base}-r${round}`,
        );
        try {
          // One waiting job on each queue of each round.
          for (const namespace of namespaces) {
            for (const name of QUEUES) {
              const queue = new BunQueue(name, {
                namespace,
                driver,
                logger: noopLogger,
              });
              await queue.add("a", {});
              await queue.close();
            }
          }

          const env = {
            SUMMON_TEST_DRIVER: JSON.stringify(backend.config),
            SUMMON_TEST_NAMESPACES: namespaces.join(","),
            SUMMON_TEST_START_AT: String(Date.now() + 3_000),
            SUMMON_TEST_SLOT_MS: String(SLOT_MS),
            SUMMON_TEST_PER_HOUR: String(PER_HOUR),
            SUMMON_TEST_CHECKS: "4",
          };
          const runs = await Promise.all(
            [0, 2, 4, 6].map(
              async (first) =>
                await runBun<RacerLine>(RACER, {
                  ...env,
                  SUMMON_TEST_QUEUES: QUEUES.slice(first, first + 2).join(","),
                }),
            ),
          );
          for (const run of runs) {
            expect(run.exitCode, run.stderr).toBe(0);
          }
          const lines = runs.flatMap((run) => run.lines);

          for (const [round, namespace] of namespaces.entries()) {
            const mine = lines.filter((line) => line.round === round);
            const calls = mine.filter((line) => line.call !== undefined);
            // Exactly the limit: never more, and the backlog of eight left
            // enough demand for every one of the five to be taken.
            expect({ round, calls: calls.length }).toEqual({
              round,
              calls: PER_HOUR,
            });
            for (const line of mine.filter((one) => one.action === "skipped")) {
              expect(["pending", "budget", "contended"]).toContain(
                String(line.reason),
              );
            }
            // The group counted every call — more only by a lost refund,
            // which a race with one controller per queue never needs.
            // Read as stored, never rolled to now: a run that crosses a UTC
            // hour would otherwise read the hour's count as 0.
            const stored = await driver.getQueueState!(
              summonGroupRef(namespace),
              summonGroupStateName("media"),
            );
            expect(isSummonGroupEntry(stored?.value)).toBe(true);
            const group = stored!.value as SummonGroupEntry;
            expect(group.budget.hour).toBe(PER_HOUR);
            expect(group.budget.day).toBe(PER_HOUR);
            const shares = Object.values(group.queues ?? {}).reduce(
              (sum, share) => sum + share.day,
              0,
            );
            expect(shares).toBe(PER_HOUR);
            // Each queue's own marker counts its own attempt: they sum to the calls.
            let counted = 0;
            for (const queue of QUEUES) {
              const marker = await driver.getQueueState!(
                { ns: namespace, queue },
                SUMMON_MARKER,
              );
              const value = marker?.value as
                | { budget?: { hour: number } }
                | undefined;
              counted += value?.budget?.hour ?? 0;
            }
            expect(counted).toBe(calls.length);
          }
        } finally {
          for (const namespace of namespaces) {
            await driver.purge(namespace).catch(() => {});
          }
          await driver.close();
        }
      });
    },
  );
}
