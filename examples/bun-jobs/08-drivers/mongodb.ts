/**
 * MongoDB — claims with one conditional `findOneAndUpdate`.
 *
 * ```bash
 * bun add mongodb   # an optional peer dependency, imported only when used
 * EXAMPLE_MONGODB_URL=mongodb://localhost/jobs bun 08-drivers/mongodb.ts
 * ```
 *
 * The `mongodb` client is loaded the first time this driver connects, so a
 * project that does not use MongoDB never installs it.
 *
 * Collections are named `jobs`, `locks`, `kv`, `events` and `jobLogs`; prefix
 * them with `collectionPrefix`, or name existing ones with `collections`.
 * `syncSchema` reconciles indexes — there are no column types to change, so
 * nothing it does can block a collection.
 */
import { BunQueue, BunQueueWorker, MongoDriver } from "@kingsleyweb/bun-jobs";
import { requireUrl, URL_VARIABLES } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

const url = requireUrl(URL_VARIABLES.mongodb, "mongodb://localhost/jobs");

title("MongoDB");

const driver = new MongoDriver({
  url,
  collectionPrefix: "bun_jobs_example_",
});
const namespace = `mongo-example-${Date.now().toString(36)}`;
await driver.connect();
show("capabilities", driver.capabilities);

/* ------------------------------------------------------------------ */
step("A queue with two competing workers");

const queue = new BunQueue<{ n: number }, string>("work", {
  namespace,
  driver,
});
const takenBy = new Map<string, number>();
const workers = ["a", "b"].map(
  (id) =>
    new BunQueueWorker<{ n: number }, string>(
      "work",
      async () => {
        takenBy.set(id, (takenBy.get(id) ?? 0) + 1);
        await Bun.sleep(2);
        return id;
      },
      { namespace, driver, id, concurrency: 4, pollInterval: 50 },
    ),
);
workers.forEach((worker) => void worker.run());

await queue.addBulk(
  Array.from({ length: 200 }, (_, n) => ({ name: "noop", data: { n } })),
);
await waitFor(
  "200 jobs",
  async () => (await queue.count("completed")) === 200,
  { timeout: 60_000, interval: 50 },
);
show("jobs taken per worker (each exactly once)", Object.fromEntries(takenBy));

step("Index drift (dry run)");
show("changes", await driver.syncSchema({ dryRun: true }));

await Promise.all(workers.map((worker) => worker.close()));
await queue.close();
await driver.purge(namespace);
await driver.close();
