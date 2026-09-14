/**
 * A live dashboard — one stream of every job and runner event in a
 * namespace, with `JobsNotifier`.
 *
 * ```bash
 * bun 09-integrations/live-dashboard.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 09-integrations/live-dashboard.ts
 * ```
 *
 * Two halves that share nothing but a backend and a namespace:
 *
 * - the **service** produces and processes jobs and runs a runner. It
 *   publishes its events because its context says `publishEvents: true`
 *   (or set `publish: true` on one queue, worker or runner). Publishing is
 *   off by default: each event is a write or a round trip.
 * - the **dashboard** opens `jobs.notifier()` and reads every event — from
 *   any process — as `for await (const event of feed)` or
 *   `feed.on("event", ...)`. A `switch` on `event.kind` then `event.type`
 *   narrows `event.payload` to exactly what that event carries.
 *
 * The notifier finds queues and runners that appear later on its own, every
 * `discoveryInterval`. Anything published before it finds them is missed, so
 * to hear a queue from its very first event, `follow()` it up front.
 *
 * In production feed a websocket or server-sent events from the loop below.
 */
import type { DriverEvent } from "@kingsleyweb/bun-jobs";
import type { CleanupArgs } from "../07-runner/handlers/cleanup";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What an invoice job carries. */
interface Invoice {
  /** The invoice to send. */
  invoiceId: string;
  /** Its amount in cents; a negative amount fails. */
  cents: number;
}

title("Live dashboard");

// One backend both halves reach. In real life these are two deployments.
const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("billing");

/* ------------------------------------------------------------------ */
step("The dashboard: follow the namespace before anything happens");

const dashboard = new BunJobs({ namespace, driver, logger: noopLogger });
const feed = await dashboard.notifier({
  queues: "all",
  runners: "all",
  discoveryInterval: 500, // look for new queues and runners twice a second
  bufferSize: 1_000, // events held for a consumer that falls behind
});

// Followed now, so not even the first event is missed.
await feed.follow("queue", "jobs");
await feed.follow("runner", "nightly-report");
show("following", feed.following);

/** How many of each `kind:type` the dashboard has seen. */
const tally = new Map<string, number>();

/** Every `kind:target` the dashboard has heard at least one event from. */
const heardFrom = new Set<string>();

/** One line for the feed. */
function describe(event: DriverEvent): string {
  const at = `${event.kind}:${event.target}`;

  if (event.kind === "runner") {
    switch (event.type) {
      case "succeeded":
        return `${at} succeeded in ${event.payload.durationMs}ms`;
      case "failed":
        return `${at} failed: ${event.payload.error.message}`;
      case "skipped":
        return `${at} skipped (${event.payload.reason})`;
      default:
        return `${at} ${event.type}`;
    }
  }

  switch (event.type) {
    case "completed":
      return `${at} ${event.payload.id} completed → ${JSON.stringify(event.payload.returnValue)}`;
    case "retrying":
      return `${at} ${event.payload.id} retrying after "${event.payload.error.message}"`;
    case "dead":
      return `${at} ${event.payload.id} DEAD: ${event.payload.error.message}`;
    case "progress":
      return `${at} ${event.payload.id} at ${String(event.payload.progress)}%`;
    default:
      return `${at} ${event.type}${event.id ? ` ${event.id}` : ""}`;
  }
}

// The dashboard's loop. It ends when the feed is closed.
const consuming = (async () => {
  for await (const event of feed) {
    const key = `${event.kind}:${event.type}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
    heardFrom.add(`${event.kind}:${event.target}`);
    show(describe(event));
  }
})();

/* ------------------------------------------------------------------ */
step("The service: jobs and a runner, publishing their events");

const service = new BunJobs({
  namespace,
  driver,
  publishEvents: true, // its queues, workers and runners all publish
  logger: noopLogger,
});

service.define<Invoice, string>(
  "sendInvoice",
  async (job) => {
    await job.updateProgress(50);
    await Bun.sleep(10);
    if (job.data.cents < 0) {
      throw new Error(`invalid amount on ${job.data.invoiceId}`);
    }
    return `sent ${job.data.invoiceId}`;
  },
  { attempts: 2, backoff: 50 },
);

const report = service.runner<CleanupArgs>({
  id: "nightly-report",
  file: new URL("../07-runner/handlers/cleanup.ts", import.meta.url),
  executionMode: "in-process",
  args: { olderThanDays: 30 },
});

await service.start({ pollInterval: 25 });
await report.start();

for (const [invoiceId, cents] of [
  ["inv-1", 1_200],
  ["inv-2", 5_000],
  ["inv-3", 250],
  ["inv-4", -1],
] as const) {
  await service.now("sendInvoice", { invoiceId, cents });
}
await report.trigger();

await waitFor("3 completions, 1 dead job and the runner's success", () => {
  return (
    tally.get("queue:completed") === 3 &&
    tally.get("queue:dead") === 1 &&
    tally.get("runner:succeeded") === 1
  );
});

/* ------------------------------------------------------------------ */
step("A producer that does not publish is not heard");

const quiet = new BunJobs({ namespace, driver, logger: noopLogger });
await feed.follow("queue", "audit");
await quiet.queue("audit").add("record", { action: "login" });
// Followed, and added to — but its context does not publish, so the feed
// stays silent. Absence is checked after a pause long enough to have heard it.
await Bun.sleep(500);
show("following queue:audit", feed.following.includes("queue:audit"));
show("heard anything from queue:audit", heardFrom.has("queue:audit"));

/* ------------------------------------------------------------------ */
step("What the dashboard saw");

show("by kind:type", Object.fromEntries([...tally.entries()].sort()));
show("dropped because the consumer fell behind", feed.dropped);

await feed.close(); // ends the for-await loop
await consuming;

await service.purge();
await Promise.all([service.close(), quiet.close(), dashboard.close()]);
await driver.close();
