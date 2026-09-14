/**
 * A producer process. Started by `main.ts`; everything arrives in the
 * environment. It knows nothing about consumers — only where to put jobs.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunJobs } from "@kingsleyweb/bun-jobs";

const producer = process.env.PRODUCER_ID ?? `producer-${process.pid}`;
const count = Number(process.env.COUNT ?? 10);

const jobs = new BunJobs({
  namespace: process.env.NAMESPACE ?? "fleet",
  driver: JSON.parse(process.env.DRIVER_CONFIG ?? "{}") as DriverConfig,
});

const orders = jobs.queue<{ orderId: string }>("orders");

await orders.addBulk(
  Array.from({ length: count }, (_, index) => ({
    name: "fulfil",
    data: { orderId: `${producer}-${index}` },
    opts: {
      // A deterministic id: a producer that crashes and reruns adds nothing twice.
      jobId: `${producer}-${index}`,
      // Kept, so main.ts can check who processed what.
      removeOnComplete: false,
    },
  })),
);

console.log(JSON.stringify({ producer, added: count }));
await jobs.close();
