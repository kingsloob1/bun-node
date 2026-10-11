// Which in-process and per-spawn limits does Bun honour?
//   bun bun-limits.ts <mode>
// Run it under a cgroup cap, e.g.
//   systemd-run --user --scope -p MemoryMax=1500M -p MemorySwapMax=0 bun bun-limits.ts worker-rl
//
// Modes:
//   alloc-heap / alloc-buffer   (worker side) allocate until a cap, report RSS
//   worker-rl     Worker + resourceLimits.maxOldGenerationSizeMb=64, heap alloc
//   worker-nt-rl  node:worker_threads Worker + the same resourceLimits
//   worker-smol   Worker + smol:true, heap alloc to 512MB
//   worker-plain  Worker, no options, heap alloc to 512MB (control)
//   spawn-opts    Bun.spawn timeout / killSignal / maxBuffer
//   spawn-cgroup  Bun.spawn({ cgroup }) into a delegated cgroup (see below)

import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { Worker as NodeWorker, parentPort } from "node:worker_threads";

const mode = process.argv[2] ?? "worker-rl";
const rssMb = (): number => Math.round(process.memoryUsage().rss / 2 ** 20);
const log = (o: object): void => console.log(JSON.stringify(o));

// Worker side: allocate JS heap (or ArrayBuffers) in 32 MiB steps up to a cap.
if (mode === "alloc-heap" || mode === "alloc-buffer") {
  const capMb = Number(process.argv[3] ?? 1024);
  const keep: unknown[] = [];
  const post = (m: object): void => {
    if (parentPort) parentPort.postMessage(m);
    else (globalThis as unknown as { postMessage: (m: object) => void }).postMessage(m);
  };
  for (let mb = 32; mb <= capMb; mb += 32) {
    if (mode === "alloc-heap") {
      // roughly 32 MiB of JS heap per step (measured: see the reported heapUsedMb)
      keep.push(Array.from({ length: 800_000 }, (_, k) => ({ k })));
    }
    else {
      keep.push(new Uint8Array(32 * 2 ** 20).fill(1));
    }
    if (mb % 128 === 0) post({ allocatedMb: mb, rssMb: rssMb(), heapUsedMb: Math.round(process.memoryUsage().heapUsed / 2 ** 20) });
  }
  post({ done: true, rssMb: rssMb() });
}

async function runWorker(label: string, make: () => Worker | NodeWorker): Promise<void> {
  log({ label, parentRssBeforeMb: rssMb() });
  const t0 = performance.now();
  const w = make();
  let last: unknown;
  await new Promise<void>((resolve) => {
    const onMsg = (m: unknown): void => {
      const data = (m as { data?: unknown }).data ?? m;
      last = data;
      if ((data as { done?: boolean }).done) resolve();
    };
    const onErr = (e: unknown): void => {
      const err = e as { message?: string; code?: string; error?: { code?: string; message?: string } };
      log({ label, event: "error", code: err.code ?? err.error?.code, message: err.message ?? err.error?.message });
      resolve();
    };
    if (w instanceof NodeWorker) {
      w.on("message", onMsg);
      w.on("error", onErr);
      w.on("exit", (code) => {
        log({ label, event: "exit", code });
        resolve();
      });
    }
    else {
      w.addEventListener("message", onMsg);
      w.addEventListener("error", onErr);
      w.addEventListener("close", (ev) => {
        log({ label, event: "close", code: (ev as CloseEvent).code });
        resolve();
      });
    }
  });
  log({ label, lastWorkerReport: last, parentRssAfterMb: rssMb(), ms: Math.round(performance.now() - t0) });
  await w.terminate();
}

const self = import.meta.path;
switch (mode) {
  case "worker-rl":
    await runWorker("Worker resourceLimits.maxOldGenerationSizeMb=64, heap to 1024MB", () =>
      new Worker(self, {
        argv: ["alloc-heap", "1024"],
        // Not in bun-types' WorkerOptions (commented out there); passed anyway.
        ...({ resourceLimits: { maxOldGenerationSizeMb: 64 } } as object),
      }));
    break;
  case "worker-nt-rl":
    await runWorker("worker_threads resourceLimits.maxOldGenerationSizeMb=64, heap to 1024MB", () =>
      new NodeWorker(self, { argv: ["alloc-heap", "1024"], resourceLimits: { maxOldGenerationSizeMb: 64 } }));
    break;
  case "worker-smol":
    await runWorker("Worker smol:true, heap to 512MB", () => new Worker(self, { argv: ["alloc-heap", "512"], smol: true }));
    break;
  case "worker-plain":
    await runWorker("Worker (no options), heap to 512MB", () => new Worker(self, { argv: ["alloc-heap", "512"] }));
    break;
  case "spawn-opts": {
    let t0 = performance.now();
    const a = Bun.spawn(["sleep", "10"], { timeout: 200, killSignal: "SIGKILL" });
    await a.exited;
    log({ probe: "timeout:200 killSignal:SIGKILL on sleep 10", ms: Math.round(performance.now() - t0), exitCode: a.exitCode, signalCode: a.signalCode });
    t0 = performance.now();
    const b = Bun.spawn(["yes"], { maxBuffer: 1_000_000, stdout: "pipe" });
    const text = await new Response(b.stdout).text();
    await b.exited;
    log({ probe: "maxBuffer:1e6 on `yes`", ms: Math.round(performance.now() - t0), bytesRead: text.length, exitCode: b.exitCode, signalCode: b.signalCode });
    const c = Bun.spawnSync(["sh", "-c", "ulimit -a | head -20"]);
    log({ probe: "child rlimits (inherited, none set by Bun)", ulimit: c.stdout.toString().trim().split("\n") });
    break;
  }
  case "spawn-cgroup": {
    // Needs a delegated cgroup: run this under
    //   systemd-run --user --scope -p Delegate=yes -p MemoryMax=1G bun bun-limits.ts spawn-cgroup
    // cgroup v2 forbids processes in a cgroup whose children get controllers,
    // so first move ourselves to a leaf, then enable memory+pids for siblings.
    const rel = readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1]!;
    const root = `/sys/fs/cgroup${rel}`;
    const sup = `${root}/supervisor`;
    const job = `${root}/job1`;
    mkdirSync(sup, { recursive: true });
    writeFileSync(`${sup}/cgroup.procs`, String(process.pid));
    writeFileSync(`${root}/cgroup.subtree_control`, "+memory +pids");
    mkdirSync(job, { recursive: true });
    writeFileSync(`${job}/memory.max`, String(64 * 2 ** 20));
    writeFileSync(`${job}/memory.swap.max`, "0");
    writeFileSync(`${job}/pids.max`, "16");
    log({ probe: "cgroup", root, job, limits: { memoryMax: "64M", pidsMax: 16 } });
    const hostile = `${import.meta.dir}/hostile.ts`;
    for (const m of [["memhog", "1024"], ["forkbomb"]]) {
      const t0 = performance.now();
      const p = Bun.spawn([process.execPath, hostile, ...m], { cgroup: job, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      await p.exited;
      const events = readFileSync(`${job}/memory.events`, "utf8").trim().replace(/\n/g, " ");
      log({ probe: `Bun.spawn({cgroup}) hostile ${m[0]}`, ms: Math.round(performance.now() - t0), exitCode: p.exitCode, signalCode: p.signalCode, lastLines: out.trim().split("\n").slice(-2), memoryEvents: events });
    }
    rmdirSync(job);
    break;
  }
  default:
    if (mode !== "alloc-heap" && mode !== "alloc-buffer") {
      console.error(`unknown mode ${mode}`);
      process.exit(2);
    }
}
