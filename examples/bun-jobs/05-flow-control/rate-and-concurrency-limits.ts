/**
 * Rate and concurrency limits — one set of numbers for every worker in every
 * process, changeable while they run.
 *
 * ```bash
 * bun 05-flow-control/rate-and-concurrency-limits.ts
 * ```
 *
 * A partner API allows 5 requests a second and 3 connections, and its bulk
 * export endpoint only one at a time. Configuring that on each worker gives
 * each worker its own 5/s — and a fleet of ten gives the partner 50/s.
 * `queue.setLimits()` stores the limits on the queue instead, so every worker
 * enforces the same numbers:
 *
 * - `rate: { max, duration }` — starts per window, queue-wide;
 * - `concurrency` — jobs running at once, queue-wide;
 * - `names: { [name]: { rate?, concurrency? } }` — the same, for one job name,
 *   on top of the queue's. A name at its limit is skipped, not waited behind.
 *
 * Enforcement is approximate by design (leases, not a global lock), so no
 * claim waits on anything; see `QueueLimiter` in the source for the trade-off.
 */
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** The kinds of partner call. */
type PartnerCall = "lookup" | "bulk-export";

title("Rate and concurrency limits");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("integrations");
const partner = new BunQueue<{ n: number }, void, PartnerCall>("partner-api", {
  namespace,
  driver,
});

step("setLimits: 5 starts/second, 3 at once, 1 bulk export at once");

await partner.setLimits({
  rate: { max: 5, duration: "1 second" },
  concurrency: 3,
  names: { "bulk-export": { concurrency: 1 } },
});
show("stored (durations in ms)", await partner.getLimits());

/**
 * Job starts per rate window.
 *
 * Rate windows are fixed and aligned to the clock — a 1-second window runs
 * from one whole second to the next, the same on every host — so starts are
 * counted by the clock second here too. (Fixed windows do allow a burst
 * across a boundary: 5 at the end of one second and 5 at the start of the
 * next is two windows' worth within a moment.)
 */
const startsPerWindow = new Map<number, number>();
/** Running now, overall and per name. */
const running = { all: 0, "bulk-export": 0 };
/** The most that ever ran at once. */
const peak = { all: 0, "bulk-export": 0 };
let finished = 0;

/** Two workers, as if in two processes — each would happily run ten jobs. */
const workers = ["worker-1", "worker-2"].map(
  (id) =>
    new BunQueueWorker<{ n: number }, void>(
      "partner-api",
      async (job) => {
        const window = Math.floor(Date.now() / 1_000);
        startsPerWindow.set(window, (startsPerWindow.get(window) ?? 0) + 1);

        running.all++;
        peak.all = Math.max(peak.all, running.all);
        if (job.name === "bulk-export") {
          running["bulk-export"]++;
          peak["bulk-export"] = Math.max(
            peak["bulk-export"],
            running["bulk-export"],
          );
        }

        await Bun.sleep(job.name === "bulk-export" ? 300 : 50);

        running.all--;
        if (job.name === "bulk-export") running["bulk-export"]--;
        finished++;
      },
      {
        namespace,
        driver,
        id,
        concurrency: 10,
        pollInterval: 25,
        // How long a worker trusts the limits it read before reading again.
        limitsRefreshInterval: 200,
      },
    ),
);
workers.forEach((worker) => void worker.run());

step("15 lookups and 3 bulk exports");

for (let n = 0; n < 15; n++) await partner.add("lookup", { n });
for (let n = 0; n < 3; n++) await partner.add("bulk-export", { n });

await waitFor("all 18 calls", () => finished === 18, { timeout: 30_000 });

show("starts in each 1-second window (max 5)", [...startsPerWindow.values()]);
show("peak running at once (max 3)", peak.all);
show("peak bulk exports at once (max 1)", peak["bulk-export"]);

step("setLimits(null): lift them — every worker sees it within 200ms");

await partner.setLimits(null);
await Bun.sleep(250);

const liftedAt = Date.now();
for (let n = 0; n < 15; n++) await partner.add("lookup", { n });
await waitFor("15 more", () => finished === 33);
show("15 unlimited lookups took", `${Date.now() - liftedAt}ms`);

await Promise.all(workers.map((worker) => worker.close()));
await partner.close();
await driver.purge(namespace);
await driver.close();
