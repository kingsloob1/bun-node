import type { BunJobs, Job } from "@kingsleyweb/bun-jobs";
import { waitFor } from "../../shared/console";

/**
 * Seeds a `BunJobs` context with something for every part of the queue
 * screens to show: jobs in every state, failures with causes and several
 * stack traces, logs, a flow, a repeatable, queue limits, a paused queue with
 * enough jobs to page through, running workers, and throughput for this
 * minute.
 *
 * It waits on conditions, never on a guessed duration, so the result is the
 * same on every backend: {@link EXPECTED_COUNTS} is what `/counts` must say
 * once `seedDemo()` resolves.
 *
 * | Queue      | What is in it                                              |
 * |------------|------------------------------------------------------------|
 * | `mail`     | every state; logs; a failure with a `cause`; limits; a repeatable; a flow's parent; a job id with a `/` |
 * | `webhooks` | a second worker, completed deliveries, one dead after two attempts |
 * | `reports`  | paused, with 45 waiting jobs: three pages at the default 20 |
 * | `render`   | the flow's two children, waiting (no worker consumes it)   |
 */

/** Job ids a demo links to, fixed so the printed URLs are stable. */
export const DEMO_IDS = {
  /** A completed job with log lines and a return value. */
  completed: "welcome-ada",
  /** A completed job whose id holds a `/`: its URL encodes it as `%2F`. */
  slashed: "invoice/2026-09/42",
  /** Dead after one attempt, with a `cause`. */
  dead: "bounce-ada",
  /** Failed once and waiting an hour for its next attempt. */
  failed: "bounce-grace",
  /** Running until the demo stops, logging as it goes. */
  active: "digest-now",
  /** Due in an hour. */
  delayed: "reminder-tomorrow",
  /** A flow's parent, waiting for its two children. */
  flowParent: "newsletter-september",
  /** Dead after two attempts, so it has two stack traces. */
  webhookDead: "hook-acme",
} as const;

/** What each queue's `/counts` must say once {@link seedDemo} resolves. */
export const EXPECTED_COUNTS = {
  mail: {
    waiting: 2,
    // The explicit delayed job and the repeatable's next occurrence.
    delayed: 2,
    active: 1,
    completed: 3,
    failed: 1,
    dead: 1,
    "waiting-children": 1,
  },
  webhooks: {
    waiting: 0,
    delayed: 0,
    active: 0,
    completed: 5,
    failed: 0,
    dead: 1,
    "waiting-children": 0,
  },
  reports: {
    waiting: 45,
    delayed: 0,
    active: 0,
    completed: 0,
    failed: 0,
    dead: 0,
    "waiting-children": 0,
  },
  render: {
    waiting: 2,
    delayed: 0,
    active: 0,
    completed: 0,
    failed: 0,
    dead: 0,
    "waiting-children": 0,
  },
} as const;

/** A queue the demo seeds. */
export type DemoQueue = keyof typeof EXPECTED_COUNTS;

/** A seeded context, and how to wind it down. */
export interface SeededDemo {
  /**
   * Keeps the demo moving for a browser: a delivery every `ms` on
   * `webhooks`, so counts, the jobs page and throughput change while the
   * screens poll. Returns a function that stops it.
   */
  trickle: (ms: number) => () => void;
  /** Lets the active job finish and closes both workers. */
  stop: () => Promise<void>;
}

/** Throws an error with a cause, the way a mail client would. */
function bounce(to: string): never {
  throw new Error(`Mailbox unavailable: ${to}`, {
    cause: Object.assign(new Error("550 5.1.1 user unknown"), {
      code: "EENVELOPE",
    }),
  });
}

/** Seeds `jobs`. `live: true` also has the active job log every 2 s. */
export async function seedDemo(
  jobs: BunJobs,
  options: { live?: boolean } = {},
): Promise<SeededDemo> {
  const mail = jobs.queue("mail");
  const webhooks = jobs.queue("webhooks");
  const reports = jobs.queue("reports");

  /* --- mail: finished jobs first, before anything blocks the worker --- */

  await mail.setLimits({
    concurrency: 5,
    rate: { max: 600, duration: "1 minute" },
  });

  for (const [jobId, to] of [
    [DEMO_IDS.completed, "ada@example.com"],
    ["welcome-grace", "grace@example.com"],
    [DEMO_IDS.slashed, "billing@example.com"],
  ] as const) {
    await mail.add("send-email", { to, template: "welcome" }, { jobId });
  }
  // One attempt: dead at the first failure.
  await mail.add(
    "bounce",
    { to: "ada@old.example" },
    { jobId: DEMO_IDS.dead, attempts: 1 },
  );
  // Three attempts an hour apart: `failed` after the first, until then.
  await mail.add(
    "bounce",
    { to: "grace@old.example" },
    { jobId: DEMO_IDS.failed, attempts: 3, backoff: 3_600_000 },
  );

  /** Resolves the running digest; set when the job starts. */
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Concurrency 1, so once the digest is running everything added after it
  // stays waiting: that is how `waiting` is made to hold still.
  const mailWorker = jobs.worker(
    "mail",
    async (job: Job<{ to?: string; template?: string }>) => {
      switch (job.name) {
        case "send-email":
          await job.log(`connecting to smtp.example.com:587`);
          await job.log(`sent ${job.data.template} to ${job.data.to}`);
          await job.updateProgress(100);
          return { messageId: `<${job.id}@smtp.example.com>` };
        case "bounce":
          await job.log(`delivering to ${job.data.to}`);
          return bounce(job.data.to ?? "unknown");
        case "send-digest": {
          await job.log("collecting this week's activity");
          await job.updateProgress({ step: "rendering", done: 1, of: 3 });
          const ticker = options.live
            ? setInterval(() => {
                void job.log(`still rendering at ${new Date().toISOString()}`);
              }, 2_000)
            : undefined;
          await released;
          clearInterval(ticker);
          return { sent: 0 };
        }
        default:
          return null;
      }
    },
    { concurrency: 1 },
  );
  void mailWorker.run();

  await waitFor("mail's finished jobs to settle", async () => {
    const counts = await mail.count();
    return counts.completed === 3 && counts.dead === 1 && counts.failed === 1;
  });

  /* --- mail: the active job, then everything that must wait behind it --- */

  await mail.add(
    "send-digest",
    { template: "digest" },
    { jobId: DEMO_IDS.active },
  );
  await waitFor("the digest to start and log", async () => {
    const job = await mail.getJob(DEMO_IDS.active);
    return job?.state === "active" && (await job.getLogs()).count > 0;
  });

  await mail.add("send-email", { to: "alan@example.com", template: "welcome" });
  await mail.add(
    "send-email",
    { to: "barbara@example.com", template: "welcome" },
    { priority: 5 },
  );
  await mail.add(
    "send-email",
    { to: "ada@example.com", template: "reminder" },
    { jobId: DEMO_IDS.delayed, delay: 3_600_000 },
  );
  // A repeatable: stored as a series, with its next occurrence as a delayed job.
  await mail.add(
    "send-digest",
    { template: "weekly-digest" },
    { repeat: { every: "1 week", key: "weekly-digest" } },
  );
  // A flow: the newsletter runs once both renders have. Nothing consumes
  // `render`, so the parent stays `waiting-children`.
  await mail.addFlow({
    name: "send-newsletter",
    data: { edition: "2026-09" },
    opts: { jobId: DEMO_IDS.flowParent },
    children: [
      { name: "render-html", data: { edition: "2026-09" }, queue: "render" },
      { name: "render-text", data: { edition: "2026-09" }, queue: "render" },
    ],
  });

  /* --- webhooks: a second worker, and a job with two stack traces --- */

  const webhookWorker = jobs.worker(
    "webhooks",
    async (job: Job<{ url: string }>) => {
      await job.log(`POST ${job.data.url}`);
      if (job.data.url.includes("acme")) {
        throw new Error(`POST ${job.data.url} answered 503`);
      }
      return { status: 204 };
    },
    { concurrency: 2 },
  );
  void webhookWorker.run();
  for (let index = 1; index <= 5; index++) {
    await webhooks.add("deliver", { url: `https://hooks.example/${index}` });
  }
  await webhooks.add(
    "deliver",
    { url: "https://acme.example/hook" },
    { jobId: DEMO_IDS.webhookDead, attempts: 2, backoff: 10 },
  );
  await waitFor("the deliveries to settle", async () => {
    const counts = await webhooks.count();
    return counts.completed === 5 && counts.dead === 1;
  });

  /* --- reports: paused, and long enough to page --- */

  await reports.pause();
  await reports.addBulk(
    Array.from({ length: 45 }, (_, index) => ({
      name: index % 3 === 0 ? "weekly-report" : "nightly-report",
      data: { day: index + 1 },
    })),
  );

  return {
    trickle: (ms) => {
      let count = 0;
      const timer = setInterval(() => {
        count++;
        void webhooks.add("deliver", {
          url: `https://hooks.example/live/${count}`,
        });
      }, ms);
      return () => clearInterval(timer);
    },
    stop: async () => {
      release();
      await Promise.all([
        mailWorker.close({ timeout: 2_000 }),
        webhookWorker.close({ timeout: 2_000 }),
      ]);
    },
  };
}
