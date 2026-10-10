import type { JobsDriver } from "../lib/index";
import type { SummonGroupEntry } from "../lib/summon/group";
import { afterAll, describe, expect, it } from "bun:test";
import { createDriver } from "../lib/index";
import { setReservedState } from "../lib/queue/windows";
import {
  chargeGroup,
  refundGroup,
  resolveSummonGroup,
  summonGroupRef,
  summonGroupStateName,
} from "../lib/summon/group";
import { DAY_MS, HOUR_MS } from "../lib/summon/marker";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * A summon group's refund on a replica whose clock is behind (review of
 * #314, round 2, LOW "skew refund").
 *
 * A group's windows roll only forward (A7), so once a replica whose clock is
 * ahead has rolled the entry into the next hour (or day), a replica a few
 * seconds behind charges into that window too: its own clock still says the
 * previous one. Its refund used to recompute the windows from the charge's
 * time on that same clock — the previous hour — find the entry's window
 * "rolled past", give nothing back and still answer `true`: the group
 * over-counted by one until the window rolled, and nothing said so. A charge
 * now reports the windows it counted in, and its refund gives back against
 * those.
 *
 * Driven through `chargeGroup`/`refundGroup` with the clock-ahead replica's
 * entry written directly (its windows one hour and one day ahead of this
 * process's clock), on every backend that keeps queue state.
 */

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

const BACKENDS = [
  {
    name: "memory",
    config: { type: "memory" as const },
    available: true,
  },
  ...(await crossProcessBackends({ cleanups })),
];

/** The group every case charges: limits high enough never to refuse. */
const GROUP = resolveSummonGroup({
  name: "g",
  budget: { perHour: 100, perDay: 1_000 },
})!;

/** A connected driver and a namespace of its own, purged after the file. */
async function open(
  backend: (typeof BACKENDS)[number],
  name: string,
): Promise<{ driver: JobsDriver; namespace: string }> {
  const driver = createDriver(backend.config);
  await driver.connect();
  const namespace = testNamespace(`group-skew-${name}-${backend.name}`);
  cleanups.push(async () => {
    await driver.purge(namespace).catch(() => {});
    await driver.close();
  });
  return { driver, namespace };
}

/** The group's entry as stored, never rolled to this process's clock. */
async function stored(
  driver: JobsDriver,
  namespace: string,
): Promise<SummonGroupEntry> {
  const entry = await driver.getQueueState!(
    summonGroupRef(namespace),
    summonGroupStateName("g"),
  );
  return entry!.value as SummonGroupEntry;
}

/**
 * Writes the entry a replica with a clock ahead left: one attempt of queue
 * `a` charged in a window one hour on, and a day window `aheadDays` on.
 */
async function writeAhead(
  driver: JobsDriver,
  namespace: string,
  aheadDays: 0 | 1,
): Promise<{ hourStart: number; dayStart: number }> {
  const now = Date.now();
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS + aheadDays * DAY_MS;
  const entry: SummonGroupEntry = {
    v: 1,
    epoch: "skew-epoch",
    budget: { hourStart, hour: 1, dayStart, day: 1 },
    limits: { perHour: 100, perDay: 1_000 },
    queues: { a: { day: 1, lastAt: now + 2_000, against: 1 } },
  };
  await setReservedState(
    driver,
    summonGroupRef(namespace),
    summonGroupStateName("g"),
    entry,
    null,
  );
  return { hourStart, dayStart };
}

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `summon group refund, a clock-behind replica: ${backend.name}`,
    () => {
      it("gives the charge back in the hour and the day it counted in, both ahead of its own clock", async () => {
        const { driver, namespace } = await open(backend, "behind");
        const ahead = await writeAhead(driver, namespace, 1);
        // This process is the replica behind: its charge counts in the
        // entry's windows, which it never rolls back.
        const charge = await chargeGroup(driver, namespace, GROUP, {
          queue: "b",
        });
        if (charge.outcome !== "charged") {
          throw new Error(charge.outcome);
        }
        expect({
          hourStart: charge.hourStart,
          dayStart: charge.dayStart,
        }).toEqual(ahead);
        expect((await stored(driver, namespace)).budget).toMatchObject({
          hour: 2,
          day: 2,
        });
        // Its claim lost: the refund lands in those windows.
        expect(
          await refundGroup(driver, namespace, "g", {
            queue: "b",
            hourStart: charge.hourStart,
            dayStart: charge.dayStart,
            clears: charge.clears,
            epoch: charge.entry.epoch,
          }),
        ).toBe(true);
        const after = await stored(driver, namespace);
        expect(after.budget).toEqual({ ...ahead, hour: 1, day: 1 });
        expect(after.queues?.b?.day).toBe(0);
        expect(after.queues?.a?.day).toBe(1);
      });

      it("control: a charge whose hour has rolled on since gives back only the day", async () => {
        const { driver, namespace } = await open(backend, "rolled");
        const charge = await chargeGroup(driver, namespace, GROUP, {
          queue: "b",
        });
        if (charge.outcome !== "charged") {
          throw new Error(charge.outcome);
        }
        // A replica ahead has since rolled the hour on and charged in it:
        // the next hour's count holds nothing of this charge's.
        const rolled = await stored(driver, namespace);
        const current = await driver.getQueueState!(
          summonGroupRef(namespace),
          summonGroupStateName("g"),
        );
        await setReservedState(
          driver,
          summonGroupRef(namespace),
          summonGroupStateName("g"),
          {
            ...rolled,
            budget: {
              ...rolled.budget,
              hourStart: charge.hourStart + HOUR_MS,
              hour: 3,
              day: rolled.budget.day + 3,
            },
          },
          current!.version,
        );
        expect(
          await refundGroup(driver, namespace, "g", {
            queue: "b",
            hourStart: charge.hourStart,
            dayStart: charge.dayStart,
            clears: charge.clears,
            epoch: charge.entry.epoch,
          }),
        ).toBe(true);
        expect((await stored(driver, namespace)).budget).toMatchObject({
          hourStart: charge.hourStart + HOUR_MS,
          hour: 3,
          dayStart: charge.dayStart,
          day: 3,
        });
      });
    },
  );
}
