/**
 * Dead-letter queues — route dead jobs somewhere, then re-drive them.
 *
 * ```bash
 * bun 06-failures/dead-letter-queue.ts
 * ```
 *
 * When a job dies, a copy can be added to another queue in the same namespace
 * as a `DeadLetter`: the original's queue, id, name, data, error and attempt
 * count. Something consumes that queue — pages on-call, opens a ticket, writes
 * an audit row — without the original worker knowing any of it.
 *
 * - `deadLetterQueue` on a worker: the default for jobs it runs;
 * - `deadLetter` on a job: wins over the worker's.
 *
 * The dead job itself stays where it died (unless `removeOnFail` says
 * otherwise), so once the cause is fixed `queue.retryAll("dead", filter)`
 * sends the backlog through again.
 */
import type { DeadLetter } from "@kingsleyweb/bun-jobs";
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What a payout job carries. */
interface Payout {
  /** The merchant being paid. */
  merchantId: string;
  /** Amount, in cents. */
  cents: number;
}

title("Dead-letter queues");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("payouts");

/** Flipped halfway through, to simulate fixing an outage. */
let bankIsUp = false;

const payouts = new BunQueue<Payout, string>("payouts", { namespace, driver });

const worker = new BunQueueWorker<Payout, string>(
  "payouts",
  async (job) => {
    if (job.data.cents > 1_000_000) {
      throw new Error("amount exceeds the fraud threshold");
    }
    if (!bankIsUp) {
      throw new Error("bank gateway unavailable");
    }
    return `paid ${job.data.merchantId}`;
  },
  {
    namespace,
    driver,
    pollInterval: 20,
    deadLetterQueue: "payouts-dead", // default for jobs that name none
  },
);

let completed = 0;
worker.on("completed", () => {
  completed++;
});
worker.on("deadLettered", (job, letter) => {
  show(`job ${job.id} dead-lettered`, `to ${letter.queue.queue}`);
});
void worker.run();

/* ------------------------------------------------------------------ */
step("A consumer for the dead letters");

/** Letters received by the on-call consumer. */
const letters: DeadLetter<Payout>[] = [];

const onCall = new BunQueueWorker<DeadLetter<Payout>, void>(
  "payouts-dead",
  async (job) => {
    letters.push(job.data);
    show(`on-call paged about ${job.name}`, {
      originalQueue: job.data.queue,
      originalId: job.data.id,
      merchant: job.data.data.merchantId,
      error: job.data.failedReason.message,
      attemptsMade: job.data.attemptsMade,
    });
  },
  { namespace, driver, pollInterval: 20 },
);
void onCall.run();

/* ------------------------------------------------------------------ */
step("Five payouts while the bank is down; one is also over the threshold");

for (const merchantId of ["m-1", "m-2", "m-3", "m-4"]) {
  await payouts.add(
    "payout",
    { merchantId, cents: 25_000 },
    { attempts: 2, backoff: 30 },
  );
}
// This one names its own dead-letter queue, overriding the worker's.
await payouts.add(
  "payout",
  { merchantId: "m-5", cents: 5_000_000 },
  { deadLetter: "fraud-review" },
);

await waitFor("four letters to on-call", () => letters.length === 4);

const fraudReview = new BunQueue("fraud-review", { namespace, driver });
await waitFor(
  "the fraud letter",
  async () => (await fraudReview.count("waiting")) === 1,
);
show(
  "fraud-review queue has waiting letters",
  await fraudReview.count("waiting"),
);
show("dead payouts", await payouts.count("dead"));

/* ------------------------------------------------------------------ */
step("The bank is back: re-drive only the jobs that died of the outage");

bankIsUp = true;
const retried = await payouts.retryAll("dead", {
  reason: /bank gateway unavailable/,
});
show("retried", retried.length);

await waitFor("the retried payouts", () => completed === 4);
show("counts", await payouts.count());

await Promise.all([worker.close(), onCall.close()]);
await Promise.all([payouts.close(), fraudReview.close()]);
await driver.purge(namespace);
await driver.close();
