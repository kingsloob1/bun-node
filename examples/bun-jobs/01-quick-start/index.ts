/**
 * Quick start — define a job, add some, process them, shut down.
 *
 * ```bash
 * bun 01-quick-start/index.ts
 * EXAMPLE_DRIVER=sqlite bun 01-quick-start/index.ts
 * ```
 *
 * `BunJobs` is one service's context: a namespace and a backend, set once.
 * Every queue, worker and runner derived from it shares both, so two services
 * sharing a Redis or a Postgres can never collide on a job name.
 *
 * The *registry* half of it — `define`, `now`, `run`, `start` — is the
 * shortest path: jobs of every name go through one queue (`"jobs"`), and one
 * worker dispatches them by name.
 */
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, title, waitFor } from "../shared/console";

/** What a `sendWelcomeEmail` job carries. */
interface WelcomeEmail {
  /** Recipient address. */
  to: string;
  /** Name to greet them by. */
  name: string;
}

title("Quick start");

const jobs = new BunJobs({
  namespace: exampleNamespace("quick-start"),
  // A config is built into a driver here, and closed by `jobs.close()`.
  driver: exampleDriver(),
});

// 1. Say how to run jobs of one name. The options are defaults for every job
//    of that name, wherever it is added from.
jobs.define<WelcomeEmail, string>(
  "sendWelcomeEmail",
  async (job, ctx) => {
    // `ctx.log` appends to the job's own log, readable from any process.
    await ctx.log(`rendering the welcome template for ${job.data.name}`);
    await Bun.sleep(25); // pretend to talk to an email provider
    return `delivered to ${job.data.to}`;
  },
  { attempts: 3, backoff: 1_000 },
);

// 2. Start consuming. One worker runs every defined name.
const worker = await jobs.start({ concurrency: 2 });

let completed = 0;
worker.on("completed", (job, result) => {
  completed++;
  show(`completed ${job.name} (${job.id})`, result);
});

// 3. Add jobs — now, or described in words.
const first = await jobs.now("sendWelcomeEmail", {
  to: "ada@example.com",
  name: "Ada",
});
show("added now", first.id);

const later = await jobs
  .run<WelcomeEmail>("sendWelcomeEmail")
  .withData({ to: "grace@example.com", name: "Grace" })
  .in("500ms")
  .start();
show("added for later", { id: later.id, state: later.state });

await waitFor("both emails to be sent", () => completed === 2);

// 4. Anything can read a job back, including its log.
const { logs } = await first.getLogs();
show("first job's log", logs);

// 5. Stop the worker (letting in-flight jobs finish) and close the backend.
await jobs.purge();
await jobs.close();
show("closed");
