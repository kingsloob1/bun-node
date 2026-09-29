// A deliberately hostile Bun script, used to check what a sandbox blocks.
// Run it ONLY inside a limit (a container with --pids-limit/--memory, or
// bwrap under a systemd-run scope with MemoryMax/TasksMax).
//
//   bun hostile.ts <mode> [...args]
//
// Every mode prints one JSON line per probe: { probe, ok, detail }.
// `ok: true` means the hostile action SUCCEEDED (i.e. was not blocked).

import { spawn } from "bun";
import * as fs from "node:fs";
import * as net from "node:net";
import { lookup } from "node:dns/promises";

function out(probe: string, ok: boolean, detail: unknown): void {
  console.log(JSON.stringify({ probe, ok, detail }));
}

function errCode(e: unknown): string {
  const err = e as { code?: string; message?: string; name?: string };
  return err.code ?? err.name ?? String(err.message ?? e);
}

async function shadow(): Promise<void> {
  try {
    const text = fs.readFileSync("/etc/shadow", "utf8");
    const first = text.split("\n")[0]?.split(":")[0];
    out("read /etc/shadow", true, { lines: text.split("\n").length, firstUser: first });
  }
  catch (e) {
    out("read /etc/shadow", false, errCode(e));
  }
}

async function tryFetch(url: string): Promise<void> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    out(`fetch ${url}`, true, { status: res.status, ms: Math.round(performance.now() - t0) });
  }
  catch (e) {
    out(`fetch ${url}`, false, { error: errCode(e), ms: Math.round(performance.now() - t0) });
  }
}

async function network(): Promise<void> {
  await tryFetch("http://1.1.1.1/");
  await tryFetch("http://169.254.169.254/");
  try {
    const r = await Promise.race([
      lookup("example.com"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
    ]);
    out("dns example.com", true, r);
  }
  catch (e) {
    out("dns example.com", false, errCode(e));
  }
}

function tcpConnect(host: string, port: number): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const sock = net.connect({ host, port });
    const done = (ok: boolean, detail: unknown): void => {
      sock.destroy();
      out(`tcp ${host}:${port}`, ok, detail);
      resolve();
    };
    sock.setTimeout(2000, () => done(false, { error: "timeout", ms: Math.round(performance.now() - t0) }));
    sock.once("connect", () => done(true, { ms: Math.round(performance.now() - t0) }));
    sock.once("error", e => done(false, { error: errCode(e), ms: Math.round(performance.now() - t0) }));
  });
}

async function host(targets: string[]): Promise<void> {
  const list = targets.length > 0
    ? targets
    : ["172.17.0.1:80", "172.17.0.1:5432", "172.17.0.1:6379", "172.17.0.2:5432", "127.0.0.1:5432"];
  for (const t of list) {
    const [h, p] = t.split(":");
    await tcpConnect(h!, Number(p));
  }
}

async function forkbomb(): Promise<void> {
  // Spawn `sleep 30` children until spawning fails; count the successes.
  // Threads count against pids.max too, so report this process's thread count.
  const threads = (() => {
    try {
      return /Threads:\s+(\d+)/.exec(fs.readFileSync("/proc/self/status", "utf8"))?.[1];
    }
    catch {
      return "?";
    }
  })();
  let pidsMax = "?";
  try {
    pidsMax = fs.readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim();
  }
  catch {}
  const children: ReturnType<typeof spawn>[] = [];
  let error = "none";
  const cap = 5000;
  const t0 = performance.now();
  for (let i = 0; i < cap; i++) {
    try {
      children.push(spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] }));
    }
    catch (e) {
      error = errCode(e);
      break;
    }
  }
  out("forkbomb", error === "none", {
    spawned: children.length,
    cap,
    firstError: error,
    ownThreads: threads,
    pidsMax,
    ms: Math.round(performance.now() - t0),
  });
  for (const c of children) c.kill(9);
  process.exit(0);
}

function memhog(): void {
  // Allocate and touch 16 MiB chunks until killed; print progress as we go.
  const chunks: Uint8Array[] = [];
  const limitMb = Number(process.argv[3] ?? 4096);
  for (let mb = 16; mb <= limitMb; mb += 16) {
    const c = new Uint8Array(16 * 1024 * 1024);
    c.fill(1);
    chunks.push(c);
    if (mb % 64 === 0) console.log(JSON.stringify({ probe: "memhog", allocatedMb: mb }));
  }
  out("memhog", true, { survivedMb: limitMb });
}

function rofs(): void {
  for (const p of ["/etc/hostile-probe", "/hostile-probe", "/usr/hostile-probe"]) {
    try {
      fs.writeFileSync(p, "x");
      out(`write ${p}`, true, "written");
    }
    catch (e) {
      out(`write ${p}`, false, errCode(e));
    }
  }
}

function tmpfs(): void {
  const target = process.argv[3] ?? "/tmp/fill";
  const mb = Number(process.argv[4] ?? 32);
  const chunk = new Uint8Array(1024 * 1024).fill(7);
  let written = 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, "w");
    for (let i = 0; i < mb; i++) {
      fs.writeSync(fd, chunk);
      written++;
    }
    out(`write ${mb}MB to ${target}`, true, { writtenMb: written });
  }
  catch (e) {
    out(`write ${mb}MB to ${target}`, false, { writtenMb: written, error: errCode(e) });
  }
  finally {
    // An open descriptor keeps the space allocated after the unlink below.
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    fs.rmSync(target, { force: true });
  }
  catch {}
  // exec from tmpfs: copy /bin/true there and try to run it (noexec check)
  try {
    fs.copyFileSync("/bin/true", "/tmp/true-copy");
    fs.chmodSync("/tmp/true-copy", 0o755);
    const p = Bun.spawnSync(["/tmp/true-copy"]);
    out("exec from /tmp", p.exitCode === 0, { exitCode: p.exitCode });
  }
  catch (e) {
    out("exec from /tmp", false, errCode(e));
  }
}

function env(): void {
  out("env", true, { keys: Object.keys(process.env).sort(), ...(process.env.SECRET_PROBE ? { SECRET_PROBE: "present" } : {}) });
}

function caps(): void {
  const status = fs.readFileSync("/proc/self/status", "utf8");
  const pick = (k: string): string | undefined => new RegExp(`${k}:\\s+(\\S+)`).exec(status)?.[1];
  out("capabilities", true, {
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    CapEff: pick("CapEff"),
    CapBnd: pick("CapBnd"),
    NoNewPrivs: pick("NoNewPrivs"),
    Seccomp: pick("Seccomp"),
  });
  try {
    fs.writeFileSync("/tmp/chown-probe", "x");
    fs.chownSync("/tmp/chown-probe", 1, 1);
    out("chown to uid 1", true, "changed");
  }
  catch (e) {
    out("chown to uid 1", false, errCode(e));
  }
  try {
    // mknod needs CAP_MKNOD; use the `mknod` binary if the image has it.
    const p = Bun.spawnSync(["mknod", "/tmp/nod-probe", "c", "1", "3"], { stderr: "pipe" });
    out("mknod char device", p.exitCode === 0, { exitCode: p.exitCode, stderr: p.stderr.toString().trim() });
  }
  catch (e) {
    out("mknod char device", false, errCode(e));
  }
}

function dockersock(): void {
  for (const p of ["/var/run/docker.sock", "/run/docker.sock"])
    out(`exists ${p}`, fs.existsSync(p), fs.existsSync(p) ? "present" : "absent");
}

function cpu(): void {
  // A fixed amount of work; compare wall time with and without a CPU cap.
  const iterations = Number(process.argv[3] ?? 300_000_000);
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  let x = 0;
  for (let i = 0; i < iterations; i++) x = (x + i * 7) % 1000003;
  const wall = performance.now() - t0;
  const used = process.cpuUsage(cpu0);
  let cpuMax = "?";
  try {
    cpuMax = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim();
  }
  catch {}
  const cpuMs = (used.user + used.system) / 1000;
  out("cpu", true, {
    iterations,
    wallMs: Math.round(wall),
    cpuMs: Math.round(cpuMs),
    cpuShare: Number((cpuMs / wall).toFixed(2)),
    cpuMax,
    x,
  });
}

function info(): void {
  let cg = "?";
  try {
    cg = fs.readFileSync("/proc/self/cgroup", "utf8").trim();
  }
  catch {}
  out("info", true, { uid: process.getuid?.(), bun: Bun.version, cgroup: cg, cwd: process.cwd() });
}

const mode = process.argv[2] ?? "info";
switch (mode) {
  case "shadow": await shadow(); break;
  case "network": await network(); break;
  case "host": await host(process.argv.slice(3)); break;
  case "forkbomb": await forkbomb(); break;
  case "memhog": memhog(); break;
  case "rofs": rofs(); break;
  case "tmpfs": tmpfs(); break;
  case "env": env(); break;
  case "caps": caps(); break;
  case "dockersock": dockersock(); break;
  case "cpu": cpu(); break;
  case "info": info(); break;
  default:
    console.error(`unknown mode ${mode}`);
    process.exit(2);
}
