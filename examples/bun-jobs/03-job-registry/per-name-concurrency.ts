/**
 * Per-name concurrency — a cap on one kind of job, across every process.
 *
 * ```bash
 * bun 03-job-registry/per-name-concurrency.ts
 * EXAMPLE_DRIVER=sqlite bun 03-job-registry/per-name-concurrency.ts
 * ```
 *
 * `define(name, handler, { concurrency: 2 })` means "at most two of these at
 * once, anywhere" — not per worker. `jobs.start()` stores it as that name's
 * limit on the registry queue (see `05-flow-control/rate-and-concurrency-limits`
 * for the queue API underneath), so a fleet enforces one number.
 *
 * Here two `BunJobs` contexts stand in for two service instances. They share
 * one backend and each runs a worker with concurrency 6, yet no more than two
 * videos ever render at once. A name at its cap is *skipped*, not waited
 * behind: emails keep flowing past the videos.
 */
import { BunJobs, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("Per-name concurrency");

// One backend, shared by both "instances".
const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("media-service");

/** Videos rendering right now, across both instances. */
let rendering = 0;
/** The most that were ever rendering at once. */
let mostRendering = 0;
/** Jobs finished, of either name. */
let finished = 0;
/** Emails that finished while at least one video was still rendering. */
let emailsDuringVideos = 0;

/** Builds one service instance: same definitions, same backend. */
async function startInstance(label: string): Promise<BunJobs> {
  const jobs = new BunJobs({ namespace, driver });

  jobs.define(
    "renderVideo",
    async () => {
      rendering++;
      mostRendering = Math.max(mostRendering, rendering);
      await Bun.sleep(120);
      rendering--;
      finished++;
      return label;
    },
    { concurrency: 2 }, // cluster-wide
  );

  jobs.define("sendEmail", async () => {
    await Bun.sleep(10);
    if (rendering > 0) emailsDuringVideos++;
    finished++;
    return label;
  });

  await jobs.start({ concurrency: 6, pollInterval: 20 });
  return jobs;
}

const instanceA = await startInstance("instance-a");
const instanceB = await startInstance("instance-b");

show(
  "limits stored on the registry queue",
  await instanceA.queue("jobs").getLimits(),
);

step("Adding 6 videos and 12 emails");

for (let index = 0; index < 6; index++) {
  await instanceA.now("renderVideo", { videoId: index });
}
for (let index = 0; index < 12; index++) {
  await instanceB.now("sendEmail", { to: `user${index}@example.com` });
}

await waitFor("all 18 jobs", () => finished === 18, { timeout: 30_000 });

show("most videos rendering at once (cap 2)", mostRendering);
show("emails that finished while videos rendered", emailsDuringVideos);

await instanceA.purge();
await instanceA.close();
await instanceB.close();
// The driver was passed as an instance, so neither context closed it.
await driver.close();
