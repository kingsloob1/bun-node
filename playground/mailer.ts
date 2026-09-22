import type { BunJobsOptions, Job } from "@kingsleyweb/bun-jobs";
import { BunJobs } from "@kingsleyweb/bun-jobs";

/**
 * A second service on the same backend, so the Workers page has something to
 * group: its workers show under `mailer` rather than `api`, with their own
 * stable keys (`mailer.emails.bulk`, `mailer.images.thumbs`).
 *
 * It shares the namespace and driver of the main context, which is how two
 * deployments of one system look: same queues, different processes. Both of
 * its workers consume queues the main service also produces to, so pausing
 * one from the UI visibly slows that queue down without stopping it.
 */

/** A started second service, and how to stop it. */
export interface MailerService {
  /** Its context, so the caller can close it last. */
  jobs: BunJobs;
  /** Stops its workers and closes the context. */
  stop: () => Promise<void>;
}

/** Waits `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Starts the `mailer` service: a bulk email worker and a thumbnail worker. */
export async function startMailer(
  options: Pick<BunJobsOptions, "namespace" | "driver" | "logger">,
): Promise<MailerService> {
  const jobs = new BunJobs({
    ...options,
    // What the Workers page groups these workers under.
    service: "mailer",
    publishEvents: true,
  });

  const bulk = jobs.worker(
    "emails",
    async (job: Job<{ to: string; template: string }>) => {
      await job.log(`mailer picked up ${job.data.template}`);
      await sleep(400 + Math.floor(Math.random() * 1_200));
      return { messageId: `<${job.id}@bulk.example.com>` };
    },
    { concurrency: 2, name: "bulk" },
  );

  // The ONLY consumer of `images` in the playground — the `api` service runs
  // none there. It works slowly through everything on that queue: the
  // thumbnail backlog the simulation seeds and keeps adding to, and the
  // newsletter flow's two renders. Pause it and `images` stops draining, and
  // the newsletter goes back to waiting on its children.
  const thumbs = jobs.worker(
    "images",
    async (job: Job<{ image?: string; width?: number; edition?: string }>) => {
      if (job.name === "thumbnail") {
        await job.log(`resizing ${job.data.image} to ${job.data.width}px`);
      } else {
        // `render-html` / `render-text`: the newsletter flow's children.
        await job.log(`${job.name} for the ${job.data.edition} edition`);
      }
      await sleep(2_000 + Math.floor(Math.random() * 3_000));
      return { bytes: 10_000 + Math.floor(Math.random() * 50_000) };
    },
    { concurrency: 1, name: "thumbs" },
  );

  for (const worker of [bulk, thumbs]) {
    void worker.run();
  }

  return {
    jobs,
    stop: async () => {
      await Promise.all(
        [bulk, thumbs].map((worker) => worker.close({ timeout: 2_000 })),
      );
      await jobs.close();
    },
  };
}
