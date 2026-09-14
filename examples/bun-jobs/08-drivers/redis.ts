/**
 * Redis — the blocking, push-based backend.
 *
 * ```bash
 * EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 08-drivers/redis.ts
 * ```
 *
 * Every other driver polls: an idle worker looks for work every
 * `pollInterval`. On Redis a worker *blocks* on the queue's wake list and
 * hears about a new job in about a millisecond, and events are published on a
 * channel rather than read back from storage. Claims are atomic because each
 * one is a Lua script, which Redis runs uninterrupted.
 *
 * Uses Bun's built-in Redis client — nothing to install.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import { RedisClient } from "bun";
import { requireUrl, URL_VARIABLES } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

const url = requireUrl(URL_VARIABLES.redis, "redis://localhost:6379/13");

title("Redis");

const config: DriverConfig = { type: "redis", url, keyPrefix: "examples:" };
const namespace = `redis-example-${Date.now().toString(36)}`;

// Two connections, as a producer and a consumer in two processes would have.
const producerDriver = createDriver(config);
const consumerDriver = createDriver(config);
show("capabilities", consumerDriver.capabilities);

const orders = new BunQueue<{ placedAt: number }, void>("orders", {
  namespace,
  driver: producerDriver,
});

/* ------------------------------------------------------------------ */
step("Blocking wait: how long an idle worker takes to notice a job");

const latencies: number[] = [];
const worker = new BunQueueWorker<{ placedAt: number }, void>(
  "orders",
  async (job) => {
    latencies.push(performance.now() - job.data.placedAt);
  },
  {
    namespace,
    driver: consumerDriver,
    maxBlock: 5_000, // block up to 5s per wait; a new job wakes it at once
    publish: true, // announce events on the channel (next step)
  },
);
void worker.run();

await Bun.sleep(300); // let the worker go idle and block

for (let index = 0; index < 5; index++) {
  await orders.add("place", { placedAt: performance.now() });
  await Bun.sleep(100); // idle again before the next one
}
await waitFor("five orders", () => latencies.length === 5);
show(
  "add → picked up, ms (a polling driver: up to pollInterval, 1000 by default)",
  latencies.map((ms) => Number(ms.toFixed(1))),
);

/* ------------------------------------------------------------------ */
step("Pushed events: a subscriber hears the worker in another connection");

const dashboard = new BunQueue("orders", {
  namespace,
  driver: producerDriver,
  subscribe: true,
});
const heard: string[] = [];
dashboard.on("completed", (job) => {
  heard.push(job.id);
});
await dashboard.connect();

const watched = await orders.add("place", { placedAt: performance.now() });
await waitFor("the dashboard to hear it", () => heard.includes(watched.id));
show("dashboard heard completion of", watched.id);

/* ------------------------------------------------------------------ */
step("What it stores: keys under the prefix and namespace");

const client = new RedisClient(url);
const keys = (await client.send("KEYS", [
  `examples:*${namespace}*`,
])) as string[];
show(`${keys.length} keys, e.g.`, keys.sort().slice(0, 8));
client.close();

await worker.close();
await Promise.all([dashboard.close(), orders.close()]);
await producerDriver.purge(namespace);
await Promise.all([producerDriver.close(), consumerDriver.close()]);
