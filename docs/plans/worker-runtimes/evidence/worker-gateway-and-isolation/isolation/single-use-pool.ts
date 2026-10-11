// The recommended default of the plan's `container` target: a pool of
// pre-started, hardened containers, each used for exactly ONE job and then
// discarded, with a replacement started at once.
//   bun single-use-pool.ts [jobs=40] [spares=4]
// Reports: time for a container to become ready, per-job dispatch latency
// when a spare is ready, and sustained jobs/s (bounded by the start rate).
import { readFileSync } from "node:fs";

const JOBS = Number(process.argv[2] ?? 40);
const SPARES = Number(process.argv[3] ?? 4);
const IMG = process.env.IMG ?? "oven/bun:1";
const HERE = import.meta.dir;
const HARD = "--read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --user 65534:65534 --cap-drop=ALL --pids-limit 64 --memory 128m --memory-swap 128m --cpus 0.5 --network none --ipc none".split(" ");
const load = () => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!.toFixed(1); };

interface Spare { name: string; proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "inherit">>; lines: AsyncIterator<string>; ready: Promise<void>; }
let seq = 0;
const names: string[] = [];
const readyMs: number[] = [];

async function* lineReader(stream: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf("\n")) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); }
  }
}

function start(): Spare {
  const name = `gwplan-su-${process.pid}-${++seq}`; names.push(name);
  const t = performance.now();
  const proc = Bun.spawn(["docker", "run", "-i", "--rm", "--name", name, ...HARD, "-v", `${HERE}:/w:ro`, "-w", "/w", IMG, "bun", "one-shot.ts"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const lines = lineReader(proc.stdout);
  const ready = lines.next().then((r) => { if (r.value !== "ready") throw new Error(`not ready: ${r.value}`); readyMs.push(performance.now() - t); });
  return { name, proc, lines, ready };
}

const before = load();
const pool: Spare[] = Array.from({ length: SPARES }, start);
await Promise.all(pool.map((s) => s.ready));
const dispatch: number[] = [];
const t0 = performance.now();
let next = 0;
async function lane() {
  while (next < JOBS) {
    const id = next++;
    const spare = pool.shift()!;
    pool.push(start());               // replacement, off the critical path
    await spare.ready;
    const t = performance.now();
    spare.proc.stdin.write(`${JSON.stringify({ id, n: 21 })}\n`); spare.proc.stdin.flush();
    const r = await spare.lines.next();
    if (JSON.parse(r.value!).result !== 42) throw new Error("bad result");
    dispatch.push(performance.now() - t);
    await spare.proc.exited;
  }
}
await Promise.all(Array.from({ length: SPARES }, lane));
const secs = (performance.now() - t0) / 1000;
// Unused spares: closing stdin ends their loop, so they exit and are removed.
for (const s of pool) { s.proc.stdin.end(); }
await Promise.race([Promise.all(pool.map((s) => s.proc.exited)), Bun.sleep(10_000)]);
const left = Bun.spawnSync(["docker", "ps", "-aq", ...names.flatMap((n) => ["--filter", `name=^${n}$`])]).stdout.toString().trim();
if (left) Bun.spawnSync(["docker", "rm", "-f", ...left.split("\n")]);
console.log(JSON.stringify({ jobs: JOBS, spares: SPARES, jobsPerSec: +(JOBS / secs).toFixed(2), dispatchMs: { p50: q(dispatch, 0.5), p90: q(dispatch, 0.9), max: q(dispatch, 1) }, readyMs: { p50: q(readyMs, 0.5), p90: q(readyMs, 0.9), max: q(readyMs, 1) }, load: { before, after: load() } }));
process.exit(0);
