/**
 * Evidence for summon-multi-queue.md §4 (where a group's shared state lives)
 * and §4.5 (compare-and-set contention on one shared entry).
 *
 * Part 1, the home: on every backend, writes a reserved queue-state entry
 * under a queue ref that was never ensured (`{ ns, queue: "__summon" }`) and
 * asks whether it reads back, lists, is invisible to `listQueues`, and goes
 * with `purge`.
 *
 * Part 2, contention: K concurrent "charges", each a read, an increment and
 * a compare-and-set retried until it lands, against ONE entry (a group's
 * shared budget) and against K separate entries (today's marker per queue).
 * Reports wall time, per-charge latency and how many retries the losers
 * made. In-process concurrency over the driver's own pool or connection: a
 * cross-process race would add its own latency, not remove any.
 *
 *   bun state-home.ts                     # memory, file, sqlite only
 *   BUN_JOBS_TEST_POSTGRES_URL=… … bun state-home.ts   # plus the servers
 *
 * Uses a fresh namespace per backend (`mqplan-<pid>-<ms>-<backend>`) and
 * purges exactly that namespace at the end.
 */
import type { DriverConfig, JobsDriver, QueueRef } from "../../../../packages/bun-jobs/lib/index";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createDriver } from "../../../../packages/bun-jobs/lib/index";
import { setReservedState } from "../../../../packages/bun-jobs/lib/queue/windows";

const PREFIX = "bun_jobs_test_";
const dir = mkdtempSync(join(tmpdir(), "mqplan-"));

const backends: { name: string; config: DriverConfig }[] = [
  { name: "memory", config: { type: "memory" } },
  { name: "file", config: { type: "file", root: join(dir, "file") } },
  { name: "sqlite", config: { type: "sql", url: `sqlite://${join(dir, "jobs.db")}` } },
];
const servers: [string, string, (url: string) => DriverConfig][] = [
  ["postgres", "BUN_JOBS_TEST_POSTGRES_URL", (url) => ({ type: "sql", url, adapter: "postgres", tablePrefix: PREFIX })],
  ["mysql", "BUN_JOBS_TEST_MYSQL_URL", (url) => ({ type: "sql", url, adapter: "mysql", tablePrefix: PREFIX })],
  ["mariadb", "BUN_JOBS_TEST_MARIADB_URL", (url) => ({ type: "sql", url, adapter: "mariadb", tablePrefix: PREFIX })],
  ["mongodb", "BUN_JOBS_TEST_MONGODB_URL", (url) => ({ type: "mongodb", url })],
  ["redis", "BUN_JOBS_TEST_REDIS_URL", (url) => ({ type: "redis", url })],
];
for (const [name, variable, toConfig] of servers) {
  const url = process.env[variable];
  if (url) {
    backends.push({ name, config: toConfig(url) });
  } else {
    console.log(`(skipped ${name}: ${variable} unset)`);
  }
}

const ENTRY = "__win:summon-group:media";

async function home(driver: JobsDriver, ns: string): Promise<Record<string, unknown>> {
  const pseudo: QueueRef = { ns, queue: "__summon" };
  const real: QueueRef = { ns, queue: "renders" };
  await driver.ensureQueue(real);
  const created = await setReservedState(driver, pseudo, ENTRY, { hour: 1 }, null);
  const read = await driver.getQueueState!(pseudo, ENTRY);
  const updated = await setReservedState(driver, pseudo, ENTRY, { hour: 2 }, read?.version ?? -1);
  const stale = await setReservedState(driver, pseudo, ENTRY, { hour: 9 }, read?.version ?? -1);
  const listed = typeof driver.listQueueState === "function"
    ? await driver.listQueueState(pseudo, { prefix: "__win:summon-group:", limit: 10 })
    : "n/a";
  const queues = await driver.listQueues(ns);
  await driver.purge(ns);
  const afterPurge = await driver.getQueueState!(pseudo, ENTRY);
  return {
    createdVersion: created,
    readBack: JSON.stringify(read?.value),
    casUpdate: updated,
    staleCasRefused: stale === null,
    listQueueState: Array.isArray(listed) ? listed.join(",") : listed,
    listQueues: queues.join(","),
    pseudoListedAsQueue: queues.includes("__summon"),
    goneAfterPurge: afterPurge === null,
  };
}

async function charge(driver: JobsDriver, q: QueueRef, name: string): Promise<{ ms: number; retries: number }> {
  const start = performance.now();
  let retries = 0;
  for (;;) {
    const entry = await driver.getQueueState!(q, name);
    const value = (entry?.value as { hour: number } | undefined) ?? { hour: 0 };
    const written = await setReservedState(driver, q, name, { hour: value.hour + 1 }, entry?.version ?? null);
    if (written !== null) {
      return { ms: performance.now() - start, retries };
    }
    retries++;
  }
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

async function contention(driver: JobsDriver, ns: string, k: number, shared: boolean): Promise<Record<string, number | string>> {
  const q: QueueRef = { ns, queue: "__summon" };
  const name = (i: number): string => (shared ? ENTRY : `${ENTRY}-${i}`);
  // Warm the entries so creation races are not what is measured.
  for (let i = 0; i < (shared ? 1 : k); i++) {
    await charge(driver, q, name(i));
  }
  const start = performance.now();
  const results = await Promise.all(Array.from({ length: k }, async (_, i) => await charge(driver, q, name(i))));
  const wall = performance.now() - start;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const retries = results.map((r) => r.retries);
  const final = await driver.getQueueState!(q, name(0));
  const expected = shared ? k + 1 : 2;
  return {
    k,
    entries: shared ? "one" : "K",
    wallMs: Number(wall.toFixed(1)),
    p50Ms: Number(pct(ms, 0.5).toFixed(1)),
    p99Ms: Number(pct(ms, 0.99).toFixed(1)),
    retriesTotal: retries.reduce((a, b) => a + b, 0),
    retriesMax: Math.max(...retries),
    countCorrect: (final?.value as { hour: number }).hour === expected ? "yes" : `NO (${JSON.stringify(final?.value)})`,
  };
}

const rows: Record<string, unknown>[] = [];
const contentionRows: Record<string, unknown>[] = [];
for (const backend of backends) {
  const ns = `mqplan-${process.pid}-${Date.now()}-${backend.name}`;
  const driver = createDriver(backend.config);
  try {
    await driver.connect();
    rows.push({ backend: backend.name, ...(await home(driver, ns)) });
    for (const k of [1, 4, 16, 64]) {
      for (const shared of [false, true]) {
        // Three rounds; the median round by wall time is kept.
        const rounds = [];
        for (let round = 0; round < 3; round++) {
          rounds.push(await contention(driver, ns, k, shared));
          await driver.purge(ns);
        }
        rounds.sort((a, b) => (a.wallMs as number) - (b.wallMs as number));
        contentionRows.push({ backend: backend.name, ...rounds[1] });
      }
    }
  } catch (error) {
    rows.push({ backend: backend.name, error: String(error) });
  } finally {
    await driver.purge(ns).catch(() => {});
    await driver.close().catch(() => {});
  }
}
rmSync(dir, { recursive: true, force: true });

console.log(`\nBun ${Bun.version} (${Bun.revision.slice(0, 8)}), ${process.platform}-${process.arch}, ${new Date().toISOString()}\n`);
console.log("## Part 1: an entry under a queue ref that was never ensured\n");
console.table(rows);
console.log("\n## Part 2: K concurrent charges, one shared entry vs K entries (median of 3 rounds)\n");
console.table(contentionRows);
