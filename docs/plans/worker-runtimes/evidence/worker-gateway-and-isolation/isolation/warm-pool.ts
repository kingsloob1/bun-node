// Per-job overhead of a warm (long-lived) sandbox against the alternatives.
//   bun warm-pool.ts [jobs=1000] [perProcessN=20]
//
// Persistent transports (pool-worker.ts over stdin/stdout NDJSON):
//   - host child      Bun.spawn(bun pool-worker.ts), no isolation
//   - bwrap child     same, inside bwrap --unshare-all
//   - docker run -i   same, inside one hardened container
// Each is measured twice: sequential (one job in flight -> latency) and
// pipelined (all jobs written at once -> throughput).
//
// Process-per-job alternatives (N=perProcessN):
//   - Bun.spawn(bun -e ...) on the host
//   - docker exec <hardened container> bun -e ...
//   - docker exec <hardened container> true   (exec overhead alone)

import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const JOBS = Number(process.argv[2] ?? 1000);
const PER = Number(process.argv[3] ?? 20);
const IMG = process.env.IMG ?? "oven/bun:1";
const HERE = import.meta.dir;
const BUN = process.execPath;
const HARD = "--read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --user 65534:65534 --cap-drop=ALL --pids-limit 64 --memory 128m --memory-swap 128m --cpus 0.5 --network none --ipc none".split(" ");
const MNT = ["-v", `${HERE}:/w:ro`, "-w", "/w"];
const BWRAP = [
  "bwrap",
  "--ro-bind", "/usr", "/usr",
  "--symlink", "usr/lib", "/lib",
  "--symlink", "usr/lib64", "/lib64",
  "--symlink", "usr/bin", "/bin",
  "--ro-bind", dirname(BUN), "/opt/bun",
  "--ro-bind", HERE, "/w",
  "--chdir", "/w",
  "--proc", "/proc",
  "--dev", "/dev",
  "--tmpfs", "/tmp",
  "--unshare-all",
  "--die-with-parent",
  "--new-session",
  "--clearenv",
  "--setenv", "PATH", "/opt/bun:/usr/bin",
  "--setenv", "HOME", "/tmp",
];

const load = (): string => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");

function stats(xs: number[]): Record<string, number> {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  const r = (x: number): number => Math.round(x * 1000) / 1000;
  return { n: s.length, min: r(s[0]!), median: r(q(0.5)), p90: r(q(0.9)), p99: r(q(0.99)), max: r(s.at(-1)!) };
}

class Pool {
  private proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  private pending = new Map<number, (v: number) => void>();
  private nextId = 1;

  constructor(cmd: string[]) {
    this.proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void this.read();
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line) as { id: number; result: number };
        this.pending.get(msg.id)?.(msg.result);
        this.pending.delete(msg.id);
        nl = buf.indexOf("\n");
      }
    }
  }

  send(n: number): Promise<number> {
    const id = this.nextId++;
    const p = new Promise<number>(resolve => this.pending.set(id, resolve));
    this.proc.stdin.write(`${JSON.stringify({ id, n })}\n`);
    this.proc.stdin.flush();
    return p;
  }

  async close(): Promise<number> {
    await this.proc.stdin.end();
    return this.proc.exited;
  }
}

async function persistent(name: string, cmd: string[]): Promise<void> {
  const l0 = load();
  const t0 = performance.now();
  const pool = new Pool(cmd);
  if ((await pool.send(1)) !== 2) throw new Error(`${name}: bad first result`);
  const firstMs = performance.now() - t0;
  for (let i = 0; i < 50; i++) await pool.send(i); // warm-up, not counted

  const lat: number[] = [];
  const s0 = performance.now();
  for (let i = 0; i < JOBS; i++) {
    const t = performance.now();
    const r = await pool.send(i);
    lat.push(performance.now() - t);
    if (r !== i * 2) throw new Error(`${name}: wrong result`);
  }
  const seqS = (performance.now() - s0) / 1000;

  const p0 = performance.now();
  const all = await Promise.all(Array.from({ length: JOBS }, (_, i) => pool.send(i)));
  const pipeS = (performance.now() - p0) / 1000;
  if (all.some((r, i) => r !== i * 2)) throw new Error(`${name}: wrong pipelined result`);

  const code = await pool.close();
  console.log(JSON.stringify({
    variant: name,
    firstJobMs: Math.round(firstMs),
    sequentialMs: stats(lat),
    sequentialJobsPerS: Math.round(JOBS / seqS),
    pipelinedJobsPerS: Math.round(JOBS / pipeS),
    exit: code,
    loadBefore: l0,
    loadAfter: load(),
  }));
}

function perProcess(name: string, cmd: string[], expect: string): void {
  const l0 = load();
  Bun.spawnSync(cmd); // warm, not counted
  const times: number[] = [];
  for (let i = 0; i < PER; i++) {
    const t = performance.now();
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    times.push(performance.now() - t);
    if (p.exitCode !== 0 || p.stdout.toString().trim() !== expect)
      throw new Error(`${name}: exit ${p.exitCode} out ${p.stdout.toString()} err ${p.stderr.toString()}`);
  }
  console.log(JSON.stringify({ variant: name, ms: stats(times), loadBefore: l0, loadAfter: load() }));
}

console.log(`jobs=${JOBS} perProcessN=${PER} image=${IMG} host bun=${Bun.version}`);

await persistent("persistent host child (Bun.spawn)", [BUN, `${HERE}/pool-worker.ts`]);
await persistent("persistent bwrap child", [...BWRAP, "bun", "pool-worker.ts"]);
await persistent("persistent docker run -i (hardened)", ["docker", "run", "-i", "--rm", "--name", `gwplan-pool-${process.pid}`, ...HARD, ...MNT, IMG, "bun", "pool-worker.ts"]);

const JOB = ["bun", "-e", "console.log(42)"];
perProcess("per-job Bun.spawn(bun -e) on host", [BUN, "-e", "console.log(42)"], "42");
perProcess("per-job bwrap bun -e", [...BWRAP, ...JOB], "42");

const exec = `gwplan-exec-${process.pid}`;
Bun.spawnSync(["docker", "run", "-d", "--name", exec, ...HARD, "--entrypoint", "sleep", IMG, "600"]);
try {
  perProcess("per-job docker exec bun -e (hardened container)", ["docker", "exec", exec, ...JOB], "42");
  perProcess("per-job docker exec echo (exec overhead alone)", ["docker", "exec", exec, "echo", "42"], "42");
}
finally {
  Bun.spawnSync(["docker", "rm", "-f", exec]);
}
