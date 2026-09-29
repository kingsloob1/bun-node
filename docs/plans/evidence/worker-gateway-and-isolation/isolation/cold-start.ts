// Cold start of one trivial Bun job under each isolation variant.
//   bun cold-start.ts [N]            (default N=10)
// Each variant runs `bun -e 'console.log(1)'` N times, one after another,
// and must print exactly "1". Reports min / median / p90 wall time in ms.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const N = Number(process.argv[2] ?? 10);
const IMG = process.env.IMG ?? "oven/bun:1";
const BUN = process.execPath;
const BUN_DIR = dirname(BUN);

const HARD = "--read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --user 65534:65534 --cap-drop=ALL --pids-limit 64 --memory 128m --memory-swap 128m --cpus 0.5 --network none --ipc none".split(" ");
const NNP = ["--security-opt", "no-new-privileges", "--security-opt", "apparmor=snap.docker.dockerd"];
const JOB = ["bun", "-e", "console.log(1)"];

const BWRAP = [
  "bwrap",
  "--ro-bind", "/usr", "/usr",
  "--symlink", "usr/lib", "/lib",
  "--symlink", "usr/lib64", "/lib64",
  "--symlink", "usr/bin", "/bin",
  "--ro-bind", BUN_DIR, "/opt/bun",
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
const SCOPE = ["systemd-run", "--user", "--scope", "--quiet", "-p", "MemoryMax=128M", "-p", "TasksMax=64", "-p", "CPUQuota=50%"];

interface Variant { name: string; run: () => string }

function sh(cmd: string[]): string {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0)
    throw new Error(`${cmd.join(" ")} -> exit ${p.exitCode}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

let seq = 0;
const variants: Variant[] = [
  { name: "host: bun -e (no isolation)", run: () => sh([BUN, "-e", "console.log(1)"]) },
  { name: "bwrap (unshare-all, clearenv)", run: () => sh([...BWRAP, "bun", "-e", "console.log(1)"]) },
  { name: "systemd-run scope + bwrap", run: () => sh([...SCOPE, ...BWRAP, "bun", "-e", "console.log(1)"]) },
  { name: "docker run --rm (defaults)", run: () => sh(["docker", "run", "--rm", IMG, ...JOB]) },
  { name: "docker run --rm (--network none only)", run: () => sh(["docker", "run", "--rm", "--network", "none", IMG, ...JOB]) },
  { name: "docker run --rm (hardened)", run: () => sh(["docker", "run", "--rm", ...HARD, IMG, ...JOB]) },
  { name: "docker run --rm (hardened + NNP)", run: () => sh(["docker", "run", "--rm", ...HARD, ...NNP, IMG, ...JOB]) },
];

function stats(xs: number[]): { min: number; median: number; p90: number } {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  return { min: Math.round(s[0]!), median: Math.round(q(0.5)), p90: Math.round(q(0.9)) };
}

const load = (): string => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");

console.log(`N=${N} image=${IMG} host bun=${Bun.version}`);
for (const v of variants) {
  const l0 = load();
  const times: number[] = [];
  v.run(); // warm the image/page cache once; not counted
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const outp = v.run();
    times.push(performance.now() - t0);
    if (outp !== "1") throw new Error(`${v.name}: unexpected output ${JSON.stringify(outp)}`);
  }
  console.log(JSON.stringify({ variant: v.name, ...stats(times), loadBefore: l0, loadAfter: load() }));
}

// docker create + docker start -a, timed separately (hardened).
{
  const l0 = load();
  const create: number[] = [];
  const start: number[] = [];
  const rm: number[] = [];
  for (let i = 0; i < N; i++) {
    const name = `gwplan-cs-${process.pid}-${seq++}`;
    let t0 = performance.now();
    sh(["docker", "create", "--name", name, ...HARD, IMG, ...JOB]);
    create.push(performance.now() - t0);
    t0 = performance.now();
    const outp = sh(["docker", "start", "-a", name]);
    start.push(performance.now() - t0);
    t0 = performance.now();
    sh(["docker", "rm", "-f", name]);
    rm.push(performance.now() - t0);
    if (outp !== "1") throw new Error(`create/start: unexpected output ${JSON.stringify(outp)}`);
  }
  console.log(JSON.stringify({ variant: "docker create (hardened)", ...stats(create), loadBefore: l0 }));
  console.log(JSON.stringify({ variant: "docker start -a (created)", ...stats(start) }));
  console.log(JSON.stringify({ variant: "docker rm -f", ...stats(rm), loadAfter: load() }));
}
