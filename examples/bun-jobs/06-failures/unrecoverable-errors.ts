/**
 * Unrecoverable errors — fail now, without spending the remaining attempts.
 *
 * ```bash
 * bun 06-failures/unrecoverable-errors.ts
 * ```
 *
 * Retrying is right for a timeout and wrong for an expired card: the next
 * four attempts will fail identically, a backoff apart, delaying the dead-job
 * alert by minutes. Throw `UnrecoverableJobError` and the job goes straight to
 * `dead`, however many attempts it had left.
 */
import { BunJobs, UnrecoverableJobError } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What a charge job carries. */
interface Charge {
  /** The order being charged. */
  orderId: string;
  /** What the payment gateway will say. */
  gatewaySays: "ok" | "card_expired" | "network_error";
}

title("Unrecoverable errors");

const jobs = new BunJobs({
  namespace: exampleNamespace("checkout"),
  driver: exampleDriver(),
});

jobs.define<Charge, string>(
  "chargeCard",
  async (job, ctx) => {
    switch (job.data.gatewaySays) {
      case "card_expired":
        // No retry will un-expire a card.
        throw new UnrecoverableJobError("card expired", {
          orderId: job.data.orderId,
        });
      case "network_error":
        throw new Error(`gateway unreachable (attempt ${ctx.attempt})`);
      default:
        return `charged ${job.data.orderId}`;
    }
  },
  { attempts: 4, backoff: 50 },
);

const worker = await jobs.start({ pollInterval: 10 });

const settled = new Map<string, string>();
worker.on("completed", (job, result) => {
  settled.set(job.id, String(result));
});
worker.on("dead", (job, error) => {
  settled.set(
    job.id,
    `dead after ${job.attemptsMade} of ${job.maxAttempts} attempts — ${error.name}: ${error.message}`,
  );
});

step("Three orders, each allowed four attempts");

const orders = [
  await jobs.now("chargeCard", { orderId: "o-1", gatewaySays: "ok" }),
  await jobs.now("chargeCard", { orderId: "o-2", gatewaySays: "card_expired" }),
  await jobs.now("chargeCard", {
    orderId: "o-3",
    gatewaySays: "network_error",
  }),
];

await waitFor("all three to settle", () => settled.size === orders.length);

for (const order of orders) {
  show(
    `${(order.data as Charge).orderId} (${(order.data as Charge).gatewaySays})`,
    settled.get(order.id),
  );
}

await jobs.purge();
await jobs.close();
