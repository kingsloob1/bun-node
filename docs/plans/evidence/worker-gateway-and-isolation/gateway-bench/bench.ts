// The queue host. Holds the driver; the executor it spawns does not.
//
//   bun bench.ts --backend memory|redis|postgres --mode direct|ws|http|pull-proxy
//                --batch on|off --jobs 20000 --concurrency 32 [--latency 500]
//
// Modes:
//   direct      an ordinary BunQueueWorker, processor in-process (today's
//               summoned worker: it holds the driver itself)
//   ws          BunQueueWorker on the host with a custom target that pushes
//               each attempt to an executor which dialled in over WebSocket
//               and granted credits (the recommended design, reversed push)
//   http        the same, with the executor long-polling POST /exchange
//   pull-proxy  no worker on the host: the executor claims and completes
//               through a thin HTTP proxy of claimJobs/completeJobs, holding
//               the lease itself (the "remote driver" alternative)
//
// --batch off hides the driver's claimJobs/completeJobs (so the worker falls
// back to one row per statement) AND sends one attempt per frame.
import type { JobsDriver, JobRecord, WorkerTargetFactory } from "../../../../../packages/bun-jobs/lib/index";
import type { Item, Outcome } from "./wire";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  BunQueue,
  BunQueueWorker,
  createDriver,
} from "../../../../../packages/bun-jobs/lib/index";
import { claimJobBatch } from "../../../../../packages/bun-jobs/lib/drivers/index";
import { open, seal, work } from "./wire";

const { values: args } = parseArgs({
  options: {
    backend: { type: "string", default: "memory" },
    mode: { type: "string", default: "direct" },
    batch: { type: "string", default: "on" },
    jobs: { type: "string", default: "20000" },
    concurrency: { type: "string", default: "32" },
    latency: { type: "string" },
  },
});

const backend = args.backend!;
const mode = args.mode!;
const batch = args.batch === "on";
const latencyN = args.latency ? Number(args.latency) : 0;
const total = latencyN || Number(args.jobs);
const concurrency = latencyN ? 1 : Number(args.concurrency);

const URLS: Record<string, string> = {
  redis: process.env.GW_REDIS_URL ?? "redis://127.0.0.1:6379/14",
  postgres:
    process.env.GW_POSTGRES_URL ??
    "postgres://bunjobs:bunjobs@127.0.0.1:5432/bun_jobs_test",
};

function makeDriver(): JobsDriver {
  if (backend === "memory") return createDriver({ type: "memory" });
  if (backend === "redis") return createDriver({ type: "redis", url: URLS.redis! });
  if (backend === "postgres")
    return createDriver({ type: "sql", url: URLS.postgres!, adapter: "postgres" });
  throw new Error(`backend ${backend}`);
}

/** Hides the plural claim/complete, keeping every other member bound. */
function withoutBatching(driver: JobsDriver): JobsDriver {
  return new Proxy(driver, {
    get(target, prop) {
      if (prop === "claimJobs" || prop === "completeJobs") return undefined;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const driver = makeDriver();
const workerDriver = batch ? driver : withoutBatching(driver);
const namespace = `gwplan-${process.pid}-${Date.now()}`;
const queueName = "bench";
const ref = { ns: namespace, queue: queueName };
const queue = new BunQueue<{ i: number }>(queueName, {
  namespace,
  driver,
  defaultJobOptions: { attempts: 1, removeOnComplete: true },
});

let done = 0;
const t0Of = new Map<string, number>();
const latencies: number[] = [];
let finish!: () => void;
const finished = new Promise<void>((r) => (finish = r));
let onOne: ((id: string) => void) | undefined;
function completedOne(id: string) {
  done++;
  onOne?.(id);
  if (!latencyN && done === total) finish();
}

// --- the reversed-push target: attempts wait in `outbox` for credits -----
const outbox: { item: Item; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
const inFlight = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let credits = 0;
let wsPeer: { send: (s: string) => number } | undefined;
const waiters: (() => void)[] = [];
let stopping = false;

function pump() {
  if (mode === "ws" && wsPeer) {
    while (credits > 0 && outbox.length > 0) {
      const take = batch ? Math.min(credits, outbox.length) : 1;
      const slice = outbox.splice(0, take);
      credits -= take;
      for (const e of slice) inFlight.set(e.item.id, e);
      wsPeer.send(seal({ t: "invoke", items: slice.map((e) => e.item) }));
    }
  } else if (mode === "http") {
    while (waiters.length > 0 && outbox.length > 0) waiters.shift()!();
  }
}

const remoteTarget: WorkerTargetFactory = () => ({
  name: `gwplan-${mode}`,
  run: (attempt) =>
    new Promise((resolve, reject) => {
      const r = attempt.record as JobRecord;
      outbox.push({ item: { id: r.id, name: r.name, data: r.data }, resolve, reject });
      queueMicrotask(pump);
    }),
});

function settle(outcomes: Outcome[]) {
  for (const o of outcomes) {
    const e = inFlight.get(o.id);
    if (!e) continue;
    inFlight.delete(o.id);
    if (o.error) e.reject(new Error(o.error));
    else e.resolve(o.result);
  }
}

// --- the host's listener (ws, http, pull-proxy) ---------------------------
let proxyToken = 0;
const server =
  mode === "direct"
    ? undefined
    : Bun.serve({
        port: 0,
        idleTimeout: 0,
        async fetch(req, srv) {
          const path = new URL(req.url).pathname;
          if (mode === "ws") {
            if (srv.upgrade(req)) return undefined;
            return new Response("upgrade", { status: 400 });
          }
          const body = open<{ results?: Outcome[]; max: number; items?: Outcome[] }>(
            await req.text(),
          );
          if (stopping) return new Response(seal({ items: [], stop: true }));
          if (mode === "http" && path === "/exchange") {
            credits += 0;
            settle(body.results ?? []);
            if (outbox.length === 0) {
              await new Promise<void>((r) => {
                waiters.push(r);
              });
            }
            if (stopping) return new Response(seal({ items: [], stop: true }));
            const slice = outbox.splice(0, Math.max(1, body.max));
            for (const e of slice) inFlight.set(e.item.id, e);
            return new Response(seal({ items: slice.map((e) => e.item) }));
          }
          if (mode === "pull-proxy" && path === "/claim") {
            const token = `px-${process.pid}-${++proxyToken}`;
            const opts = { workerId: "gw-proxy", token, lockMs: 30000, now: Date.now() };
            let records = await claimJobBatch(workerDriver, ref, opts, body.max);
            if (records.length === 0) {
              const ac = new AbortController();
              await driver.waitForJob(ref, 1000, ac.signal).catch(() => {});
              if (stopping) return new Response(seal({ items: [], stop: true }));
              records = await claimJobBatch(workerDriver, ref, { ...opts, now: Date.now() }, body.max);
            }
            return new Response(
              seal({ items: records.map((r) => ({ id: r.id, name: r.name, data: r.data, token })) }),
            );
          }
          if (mode === "pull-proxy" && path === "/complete") {
            const items = body.items ?? [];
            const byToken = new Map<string, Outcome[]>();
            for (const o of items) {
              const list = byToken.get(o.token!) ?? [];
              list.push(o);
              byToken.set(o.token!, list);
            }
            for (const [token, list] of byToken) {
              if (workerDriver.completeJobs) {
                const ids = await workerDriver.completeJobs(
                  ref,
                  token,
                  list.map((o) => ({ id: o.id, result: o.result, retention: true })),
                  Date.now(),
                );
                for (const id of ids) completedOne(id);
              } else {
                for (const o of list) {
                  if (await workerDriver.completeJob(ref, o.id, token, o.result, true, Date.now())) {
                    completedOne(o.id);
                  }
                }
              }
            }
            return new Response(seal({ ok: true }));
          }
          return new Response("not found", { status: 404 });
        },
        websocket: {
          open(ws) {
            wsPeer = ws;
          },
          message(_ws, raw) {
            const msg = open<{ t: string; n?: number; items?: Outcome[] }>(String(raw));
            if (msg.t === "credit") credits += msg.n!;
            if (msg.t === "results") {
              credits += msg.items!.length;
              settle(msg.items!);
            }
            pump();
          },
        },
      });

// --- the worker (every mode but pull-proxy) --------------------------------
let worker: BunQueueWorker<{ i: number }> | undefined;
if (mode !== "pull-proxy") {
  worker = new BunQueueWorker<{ i: number }>(
    queueName,
    mode === "direct"
      ? (job) => work({ id: job.id, name: job.name, data: job.data })
      : () => undefined,
    {
      namespace,
      driver: workerDriver,
      concurrency,
      autorun: false,
      ...(mode === "direct" ? {} : { target: remoteTarget }),
    },
  );
  worker.on("error", (e) => console.error("worker error", e));
  worker.on("completed", (job) => completedOne(job.id));
}

let child: ReturnType<typeof Bun.spawn> | undefined;
if (server) {
  const scheme = mode === "ws" ? "ws" : "http";
  child = Bun.spawn(
    ["bun", `${import.meta.dir}/executor.ts`, mode, `${scheme}://127.0.0.1:${server.port}`, String(concurrency), batch ? "on" : "off"],
    { stdout: "inherit", stderr: "inherit" },
  );
}

const load = (await Bun.file("/proc/loadavg").text()).trim();
let seconds = 0;

if (latencyN) {
  if (worker) void worker.run();
  await Bun.sleep(300);
  for (let i = 0; i < latencyN; i++) {
    const t = performance.now();
    const seen = new Promise<void>((r) => {
      onOne = () => r();
    });
    await queue.add("bench", { i });
    await seen;
    latencies.push(performance.now() - t);
  }
} else {
  // Enqueue first, then time the drain alone.
  const chunk = 1000;
  for (let i = 0; i < total; i += chunk) {
    await queue.addBulk(
      Array.from({ length: Math.min(chunk, total - i) }, (_, k) => ({ name: "bench", data: { i: i + k } })),
    );
  }
  const t = performance.now();
  if (worker) void worker.run();
  await finished;
  seconds = (performance.now() - t) / 1000;
}

stopping = true;
while (waiters.length) waiters.shift()!();
wsPeer?.send(seal({ t: "stop", items: [] }));
await worker?.close({ timeout: 5000 }).catch(() => {});
child?.kill();
await child?.exited;
await driver.drainQueue(ref, true).catch(() => {});
await queue.close().catch(() => {});
server?.stop(true);
await driver.close().catch(() => {});

const pct = (p: number) => {
  const s = [...latencies].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!.toFixed(2);
};
console.log(
  JSON.stringify({
    backend,
    mode,
    batch: batch ? "on" : "off",
    concurrency,
    jobs: total,
    ...(latencyN
      ? { p50ms: pct(50), p90ms: pct(90), p99ms: pct(99) }
      : { seconds: seconds.toFixed(2), jobsPerSec: Math.round(total / seconds) }),
    loadavg: load,
  }),
);
process.exit(0);
