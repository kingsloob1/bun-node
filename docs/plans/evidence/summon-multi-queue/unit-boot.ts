/**
 * Evidence for summon-multi-queue.md §7.1 (when one unit serving several
 * queues is worth it): what a unit costs **on this host** to bring up, as one
 * process with N workers against N processes with one worker each.
 *
 * For each backend and N in 1, 4, 8: starts the unit(s) at once
 * (`unit.ts`), and measures, from the spawn, the time until every queue has a
 * heartbeat record the controller would count (`listWorkerRecords`), the
 * children's own time to `ready`, and their RSS summed. Three rounds; the
 * median by time-to-registered is kept. Then SIGTERMs them and waits.
 *
 * This is the Bun-and-driver part of a boot only. A platform's cold start
 * (image pull, VM, scheduling) comes on top, per unit, and is the larger
 * term: the plan takes it from summon-compute.md's evidence, not from here.
 *
 *   bun unit-boot.ts                                  # sqlite only
 *   BUN_JOBS_TEST_POSTGRES_URL=… BUN_JOBS_TEST_REDIS_URL=… bun unit-boot.ts
 */
import type { DriverConfig } from "../../../../packages/bun-jobs/lib/index";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createDriver } from "../../../../packages/bun-jobs/lib/index";
import { listWorkerRecords } from "../../../../packages/bun-jobs/lib/drivers/readApis";

const dir = mkdtempSync(join(tmpdir(), "mqboot-"));
const backends: { name: string; config: DriverConfig }[] = [
  { name: "sqlite", config: { type: "sql", url: `sqlite://${join(dir, "jobs.db")}` } },
];
if (process.env.BUN_JOBS_TEST_POSTGRES_URL) {
  backends.push({
    name: "postgres",
    config: { type: "sql", url: process.env.BUN_JOBS_TEST_POSTGRES_URL, adapter: "postgres", tablePrefix: "bun_jobs_test_" },
  });
}
if (process.env.BUN_JOBS_TEST_REDIS_URL) {
  backends.push({ name: "redis", config: { type: "redis", url: process.env.BUN_JOBS_TEST_REDIS_URL } });
}

const UNIT = new URL("./unit.ts", import.meta.url).pathname;

interface Round {
  backend: string;
  n: number;
  shape: string;
  processes: number;
  registeredMs: number;
  slowestReadyMs: number;
  rssMbTotal: number;
}

async function round(backend: { name: string; config: DriverConfig }, n: number, shared: boolean): Promise<Round> {
  const ns = `mqboot-${process.pid}-${Date.now()}-${backend.name}`;
  const queues = Array.from({ length: n }, (_, i) => `q${i}`);
  const driver = createDriver(backend.config);
  await driver.connect();
  for (const queue of queues) {
    await driver.ensureQueue({ ns, queue });
  }
  const groups = shared ? [queues] : queues.map((queue) => [queue]);
  const start = performance.now();
  const children = groups.map((group) =>
    Bun.spawn(["bun", UNIT, ns, ...group], {
      env: { ...process.env, MQ_DRIVER: JSON.stringify(backend.config) },
      stdout: "pipe",
      stderr: "inherit",
    }),
  );
  // Every queue counted by the controller's own reading.
  let registeredMs = Number.NaN;
  for (;;) {
    const counts = await Promise.all(
      queues.map(async (queue) => (await listWorkerRecords(driver, { ns, queue }, Date.now())).length),
    );
    if (counts.every((count) => count > 0)) {
      registeredMs = performance.now() - start;
      break;
    }
    if (performance.now() - start > 60_000) {
      throw new Error("units did not register within 60 s");
    }
    await Bun.sleep(5);
  }
  const lines = await Promise.all(
    children.map(async (child) => {
      const reader = child.stdout.getReader();
      let text = "";
      while (!text.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        text += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      return JSON.parse(text.split("\n")[0]!) as { readyMs: number; rssMb: number };
    }),
  );
  for (const child of children) {
    child.kill("SIGTERM");
  }
  await Promise.all(children.map(async (child) => await child.exited));
  await driver.purge(ns);
  await driver.close();
  return {
    backend: backend.name,
    n,
    shape: shared ? "1 unit × N workers" : "N units × 1 worker",
    processes: children.length,
    registeredMs: Math.round(registeredMs),
    slowestReadyMs: Math.max(...lines.map((line) => line.readyMs)),
    rssMbTotal: lines.reduce((sum, line) => sum + line.rssMb, 0),
  };
}

const rows: Round[] = [];
for (const backend of backends) {
  for (const n of [1, 4, 8]) {
    for (const shared of n === 1 ? [true] : [true, false]) {
      const rounds: Round[] = [];
      for (let i = 0; i < 3; i++) {
        rounds.push(await round(backend, n, shared));
      }
      rounds.sort((a, b) => a.registeredMs - b.registeredMs);
      rows.push(rounds[1]!);
    }
  }
}
rmSync(dir, { recursive: true, force: true });
console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 8)}), ${process.platform}-${process.arch}, ${new Date().toISOString()}`);
console.table(rows);
