/**
 * Q: What would a worker-thread or child-process target pay, per attempt, to
 * run a processor that lives in a Nest DI container? bun-jobs starts a fresh
 * thread or process for every attempt, so the whole Nest bootstrap is paid
 * each time. Measured: spawn-to-exit wall time and the in-child bootstrap
 * time, with and without Nest, 7 runs each, median.
 *
 * Run: bun boot-cost.ts
 */
const child = `${import.meta.dir}/nest-boot-child.ts`;
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function spawnOnce(bare: boolean) {
  const t0 = performance.now();
  const proc = Bun.spawn([process.execPath, child, ...(bare ? ["--bare"] : [])], { cwd: import.meta.dir, stdout: "pipe", stderr: "inherit", env: { ...process.env } });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return { wall: performance.now() - t0, inside: JSON.parse(out.trim()).ms as number };
}

async function threadOnce(bare: boolean) {
  const t0 = performance.now();
  const worker = new Worker(child, { argv: bare ? ["--bare"] : [] } as WorkerOptions);
  const inside = await new Promise<number>((resolve, reject) => {
    worker.onmessage = (e) => resolve((e.data as { ms: number }).ms);
    worker.onerror = (e) => reject(e);
  });
  const wall = performance.now() - t0;
  worker.terminate();
  return { wall, inside };
}

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), load ${(await Bun.file("/proc/loadavg").text()).split(" ").slice(0, 3).join(" ")}`);
for (const [label, fn] of [["child process", spawnOnce], ["worker thread", threadOnce]] as const) {
  for (const bare of [true, false]) {
    const runs = [] as { wall: number; inside: number }[];
    for (let i = 0; i < 7; i++) runs.push(await fn(bare));
    console.log(`${label.padEnd(13)} ${bare ? "bun-jobs only     " : "bun-jobs + Nest ctx"}: wall median ${median(runs.map((r) => r.wall)).toFixed(0)} ms, in-child bootstrap median ${median(runs.map((r) => r.inside)).toFixed(0)} ms (wall: ${runs.map((r) => r.wall.toFixed(0)).join(", ")})`);
  }
}
