import type { JobsDriver } from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { BunQueue, createDriver } from "../lib/index";
import {
  chargeGroup,
  readGroup,
  resolveSummonGroup,
} from "../lib/summon/group";
import { testNamespace } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";
import { runBun } from "./helpers/spawnBun";

/**
 * A summon group's refusal is believed once nothing of this queue's is in
 * flight (review of #314, the examples' finding): a fresh controller, in a
 * process of its own, checking a queue whose group another process spent a
 * second earlier — that charge's claim landed and its attempt settled — is
 * refused with `budget` and tells `budget-exhausted` once. It used to answer
 * `contended` for five seconds after any charge of the same queue, taking a
 * settled charge for a replica's still being claimed.
 *
 * The control: a charge of the same queue made against the very marker
 * version the check reads, whose claim has not landed, is still a replica's
 * attempt in flight — answered `contended`, with no alert (A2).
 *
 * Every backend a summon controller runs on (the memory driver refuses one).
 */

setDefaultTimeout(120_000);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

const MEMBER = join(
  import.meta.dir,
  "fixtures",
  "processes",
  "summon-group-member.ts",
);
const BACKENDS = await crossProcessBackends({ cleanups });

/** One line the member process printed. */
interface MemberLine {
  alert?: string;
  action?: string;
  reason?: string | null;
  outcome?: string | null;
  ms?: number;
}

/** One check of `queue` in group `media`, in a process of its own. */
async function member(
  backend: { config: unknown },
  namespace: string,
  queue: string,
): Promise<{ check: MemberLine | undefined; alerts: string[] }> {
  const run = await runBun<MemberLine>(MEMBER, {
    SUMMON_TEST_DRIVER: JSON.stringify(backend.config),
    SUMMON_TEST_NAMESPACE: namespace,
    SUMMON_TEST_QUEUE: queue,
    SUMMON_TEST_PER_HOUR: "1",
  });
  expect(run.exitCode, run.stderr).toBe(0);
  return {
    check: run.lines.find((line) => line.action !== undefined),
    alerts: run.lines.flatMap((line) =>
      line.alert === undefined ? [] : [line.alert],
    ),
  };
}

/** A connected driver and a namespace with one job waiting on `queue`. */
async function setUp(
  backend: { config: unknown },
  name: string,
  queue: string,
): Promise<{ driver: JobsDriver; namespace: string }> {
  const driver = createDriver(backend.config as never);
  await driver.connect();
  const namespace = testNamespace(name);
  cleanups.push(async () => {
    await driver.purge(namespace).catch(() => {});
    await driver.close();
  });
  const one = new BunQueue(queue, { namespace, driver, logger: noopLogger });
  await one.add("a", {});
  await one.close();
  return { driver, namespace };
}

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `summon group, a settled charge: ${backend.name}`,
    () => {
      it("a fresh controller in another process believes a group spent by a charge that settled a second ago", async () => {
        const { driver, namespace } = await setUp(
          backend,
          `group-settled-${backend.name}`,
          "remote-builds",
        );
        const first = await member(backend, namespace, "remote-builds");
        expect([first.check?.action, first.check?.outcome]).toEqual([
          "summoned",
          "unavailable",
        ]);
        await Bun.sleep(1_000);
        const second = await member(backend, namespace, "remote-builds");
        expect({
          action: second.check?.action,
          reason: second.check?.reason,
          exhausted: second.alerts.filter((one) => one === "budget-exhausted")
            .length,
        }).toEqual({ action: "skipped", reason: "budget", exhausted: 1 });
        const { entry } = await readGroup(
          driver,
          namespace,
          "media",
          Date.now(),
        );
        expect(entry.budget.hour).toBe(1);
      });

      it("control: a charge against the marker version the check reads, its claim not landed, is still in flight", async () => {
        const { driver, namespace } = await setUp(
          backend,
          `group-in-flight-${backend.name}`,
          "remote-builds",
        );
        // A replica's charge for this queue, made against the marker the
        // check will read (none yet), whose claim has not landed.
        const charge = await chargeGroup(
          driver,
          namespace,
          resolveSummonGroup({
            name: "media",
            budget: { perHour: 1, perDay: 10 },
          })!,
          { queue: "remote-builds", against: null },
        );
        expect(charge.outcome).toBe("charged");
        const check = await member(backend, namespace, "remote-builds");
        expect({
          action: check.check?.action,
          reason: check.check?.reason,
          alerts: check.alerts,
        }).toEqual({ action: "skipped", reason: "contended", alerts: [] });
      });
    },
  );
}
