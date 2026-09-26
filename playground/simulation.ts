import type { BunJobs, Job } from "@kingsleyweb/bun-jobs";
import { startScheduling } from "./scheduling";
import { startTargets } from "./targets";

/**
 * A small, always-moving world for the UI to show:
 *
 * | Queue      | Worker                     | What you see                                       |
 * |------------|----------------------------|----------------------------------------------------|
 * | `emails`   | 3 at a time, 0.5–3 s each  | logs, progress 0→100, ~15% fail and retry, a few dead |
 * | `reports`  | 1 at a time, 6–15 s each   | a long progress bar (`{ step, done, of }`), a backlog |
 * | `webhooks` | rate-limited 20/min        | retries with backoff, a dead-letter pile           |
 * | `images`   | none here — `mailer.ts` runs its only worker (1 at a time, 2–5 s) | a backlog that drains slowly; pause that worker and it grows |
 *
 * plus a weekly-digest repeat series on `emails`, a flow (a newsletter
 * waiting on two renders in `images`) and a delayed reminder. A producer adds
 * a job every `intervalMs`; the returned `stop` ends the producer and the
 * workers.
 *
 * Two more worlds hang off this one, each in its own file because each is
 * about one thing:
 *
 * - `targets.ts` — `checksums`, `previews` and `imports`, whose workers run
 *   a processor **file** in a child process or a `Worker`.
 * - `scheduling.ts` — `notifications` and `dead-letters`, where every way of
 *   saying *when*, *how often* and *what if it fails* is seeded once.
 *
 * They are started here, and their workers close with these.
 */

/** Options for {@link startSimulation}. */
export interface SimulationOptions {
  /** How often the producer adds a job, in ms. `0` adds none after seeding. */
  intervalMs: number;
}

/** A running simulation. */
export interface Simulation {
  /** Stops the producer and closes the workers. */
  stop: () => Promise<void>;
}

/** Waits `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A random integer in [min, max]. */
function between(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** A random element. */
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

const PEOPLE = ["ada", "grace", "alan", "barbara", "edsger", "margaret"];
const TEMPLATES = ["welcome", "reset-password", "invoice", "reminder"];
const PARTNERS = ["acme", "globex", "initech", "umbrella"];

/** Seeds the queues and starts the workers and the producer. */
export async function startSimulation(
  jobs: BunJobs,
  options: SimulationOptions,
): Promise<Simulation> {
  const emails = jobs.queue("emails");
  const reports = jobs.queue("reports");
  const webhooks = jobs.queue("webhooks");
  const images = jobs.queue("images");

  await webhooks.setLimits({ rate: { max: 20, duration: "1 minute" } });

  const emailWorker = jobs.worker(
    "emails",
    async (job: Job<{ to: string; template: string }>) => {
      await job.log(`rendering ${job.data.template} for ${job.data.to}`);
      const steps = between(2, 5);
      for (let step = 1; step <= steps; step++) {
        await sleep(between(150, 600));
        await job.updateProgress(Math.round((step / steps) * 100));
      }
      if (Math.random() < 0.15) {
        throw new Error(`550 mailbox unavailable: ${job.data.to}`, {
          cause: Object.assign(new Error("smtp.example.com refused RCPT"), {
            code: "EENVELOPE",
          }),
        });
      }
      await job.log(`sent to ${job.data.to}`);
      return { messageId: `<${job.id}@smtp.example.com>` };
    },
    {
      concurrency: 3,
      // A stable name, so its key is `api.emails.transactional` and a
      // settings override survives a restart of the playground.
      name: "transactional",
      // Lets the Stop dialog offer "until somebody starts it again".
      stopPersistenceOverridable: true,
    },
  );

  const reportWorker = jobs.worker(
    "reports",
    async (job: Job<{ month: string }>) => {
      const of = 5;
      for (let done = 1; done <= of; done++) {
        await job.log(`section ${done}/${of} of the ${job.data.month} report`);
        await job.updateProgress({ step: "rendering", done, of });
        await sleep(between(1_200, 3_000));
      }
      return { pages: between(4, 40) };
    },
    { concurrency: 1, name: "monthly" },
  );

  const webhookWorker = jobs.worker(
    "webhooks",
    async (job: Job<{ partner: string; event: string }>) => {
      await job.log(`POST https://${job.data.partner}.example/hooks`);
      await sleep(between(100, 400));
      const randomVal = Math.random();
      if (job.data.partner === "umbrella" || randomVal < 0.1) {
        throw new Error(
          `POST ${job.data.partner}.example answered 503 - random val is ${randomVal}`,
        );
      }
      return { status: 204 };
    },
    { concurrency: 2, name: "delivery" },
  );

  // The two worlds of their own. Each creates its queues, starts its workers
  // and seeds itself; their workers join the list this module closes.
  const offThread = await startTargets(jobs);
  const scheduled = await startScheduling(jobs);

  const workersMap = [
    emailWorker,
    reportWorker,
    webhookWorker,
    ...offThread.workers,
    ...scheduled.workers,
  ];
  for (const worker of [emailWorker, reportWorker, webhookWorker]) {
    void worker.run();
  }

  // --- A seed, so every screen has something from the first second ---
  const addEmail = () =>
    emails.add(
      "send-email",
      { to: `${pick(PEOPLE)}@example.com`, template: pick(TEMPLATES) },
      { attempts: 3, backoff: 5_000 },
    );
  const addWebhook = () =>
    webhooks.add(
      "deliver",
      { partner: pick(PARTNERS), event: pick(["order.paid", "user.created"]) },
      {
        attempts: 4,
        backoff: { type: "exponential", delay: 2_000 },
      },
    );

  for (let i = 0; i < 12; i++) {
    await addEmail();
  }
  for (let i = 0; i < 6; i++) {
    await addWebhook();
  }
  for (const month of ["2026-06", "2026-07", "2026-08", "2026-09"]) {
    await reports.add("monthly-report", { month });
  }
  for (let i = 0; i < 25; i++) {
    await images.add("thumbnail", { image: `photo-${i}.jpg`, width: 320 });
  }
  await emails.add(
    "send-email",
    { to: "ada@example.com", template: "reminder" },
    { jobId: "reminder-tomorrow", delay: 24 * 3_600_000 },
  );
  await emails.add(
    "send-digest",
    { template: "weekly-digest" },
    { repeat: { every: "1 week", key: "weekly-digest" } },
  );
  await emails.add(
    "send-digest",
    { template: "daily-summary" },
    { repeat: { every: "1 day", key: "daily-summary" } },
  );
  // A flow: the newsletter goes out once both renders ran. The renders are on
  // `images`, whose only worker is the `mailer` service's (`mailer.ts`), so
  // the newsletter sits in `waiting-children` until that worker reaches them
  // behind the thumbnail backlog — or for good while it is paused.
  await emails.addFlow({
    name: "send-newsletter",
    data: { edition: "2026-09" },
    opts: { jobId: "newsletter-2026-09" },
    children: [
      { name: "render-html", data: { edition: "2026-09" }, queue: "images" },
      { name: "render-text", data: { edition: "2026-09" }, queue: "images" },
    ],
  });

  // --- The producer ---
  //
  // The off-thread and scheduled queues are fed too, but sparingly: a checksum
  // is a child process and a preview a fresh `Worker`, so a steady 2 s drip of
  // them would be a benchmark rather than a playground. `imports` is fed by
  // nobody — each of its jobs has to be killed, and the two seeded ones are
  // enough to watch that happen; use `Add job` on that queue for more.
  const producer =
    options.intervalMs > 0
      ? setInterval(() => {
          const roll = Math.random();
          const add =
            roll < 0.45
              ? addEmail()
              : roll < 0.7
                ? addWebhook()
                : roll < 0.8
                  ? images.add("thumbnail", {
                      image: `upload-${Date.now()}.jpg`,
                      width: 320,
                    })
                  : roll < 0.9
                    ? scheduled.addNotification()
                    : roll < 0.96
                      ? offThread.addPreview()
                      : offThread.addChecksum();
          add.catch((error: unknown) => {
            console.error("playground producer:", error);
          });
        }, options.intervalMs)
      : undefined;

  return {
    stop: async () => {
      clearInterval(producer);
      await Promise.all(
        workersMap.map((worker) => worker.close({ timeout: 2_000 })),
      );
    },
  };
}
