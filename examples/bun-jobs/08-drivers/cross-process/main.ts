/**
 * Across processes — two producers and three consumers, five processes, one
 * backend, every job processed exactly once.
 *
 * ```bash
 * bun 08-drivers/cross-process/main.ts                        # a shared SQLite file
 * EXAMPLE_DRIVER=file bun 08-drivers/cross-process/main.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 \
 *   bun 08-drivers/cross-process/main.ts
 * ```
 *
 * `producer.ts` and `consumer.ts` share no code with each other beyond the
 * package: they agree on a namespace, a queue name and a backend, handed to
 * them in the environment. That is the whole contract — the same one two
 * services in two repositories would have.
 *
 * Consumers are stopped with `SIGTERM` and shut down gracefully, finishing
 * what they hold, as they would under a deploy.
 */
import type { Subprocess } from "bun";
import process from "node:process";
import { BunQueue, createDriver } from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../../shared/backend";
import { show, step, title, waitFor } from "../../shared/console";

title("Across processes");

const config = crossProcessDriver();
const namespace = exampleNamespace("fleet");
const JOBS_PER_PRODUCER = 60;

/** Environment every child gets: where to meet. */
const env = {
  ...process.env,
  NAMESPACE: namespace,
  DRIVER_CONFIG: JSON.stringify(config),
};

/** Starts one of the sibling scripts as its own `bun` process. */
function spawn(
  script: string,
  extra: Record<string, string>,
): Subprocess<"ignore", "pipe", "inherit"> {
  return Bun.spawn(
    [process.execPath, new URL(script, import.meta.url).pathname],
    {
      env: { ...env, ...extra },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
}

/* ------------------------------------------------------------------ */
step("Start three consumers, then two producers");

const consumers = ["consumer-1", "consumer-2", "consumer-3"].map((id) =>
  spawn("./consumer.ts", { CONSUMER_ID: id }),
);
const producers = ["producer-a", "producer-b"].map((id) =>
  spawn("./producer.ts", { PRODUCER_ID: id, COUNT: String(JOBS_PER_PRODUCER) }),
);
show("pids", {
  consumers: consumers.map((child) => child.pid),
  producers: producers.map((child) => child.pid),
});

await Promise.all(producers.map((child) => child.exited));
show("producers finished and exited");

/* ------------------------------------------------------------------ */
step("Watch the queue from this process until it is empty");

const driver = createDriver(config);
const orders = new BunQueue<{ orderId: string }, { by: string }>("orders", {
  namespace,
  driver,
});

const total = JOBS_PER_PRODUCER * producers.length;
await waitFor(
  `${total} completed jobs`,
  async () => (await orders.count("completed")) === total,
  { timeout: 60_000, interval: 50 },
);
show("counts", await orders.count());

/* ------------------------------------------------------------------ */
step("Stop the consumers with SIGTERM");

for (const child of consumers) child.kill("SIGTERM");
const reports = await Promise.all(
  consumers.map(async (child) => {
    const lines = (await new Response(child.stdout).text()).trim().split("\n");
    return JSON.parse(lines.at(-1)!) as { id: string; processed: number };
  }),
);
show("what each consumer says it processed", reports);

/* ------------------------------------------------------------------ */
step("Check: every job exactly once");

const completed = await orders.list("completed", { limit: total + 10 });
const perConsumer = Object.groupBy(
  completed,
  (job) => job.returnValue?.by ?? "?",
);
const ids = new Set(completed.map((job) => job.id));

show("distinct job ids completed", `${ids.size} of ${total}`);
show(
  "by consumer (from the job records)",
  Object.fromEntries(
    Object.entries(perConsumer).map(([id, jobs]) => [id, jobs?.length]),
  ),
);
show(
  "consumers' own counts add up",
  reports.reduce((sum, report) => sum + report.processed, 0) === total,
);

await orders.close();
await driver.purge(namespace);
await driver.close();
