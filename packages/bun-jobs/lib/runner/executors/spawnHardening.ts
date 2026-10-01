import type { SpawnCgroupOptions, SpawnOptions } from "../types";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { parseByteSize, sleep } from "@kingsleyweb/bun-common";
import { checkChildEnv } from "../../shared/childEnv";
import { ConfigError } from "../../shared/errors";

/**
 * The checks and the per-child cgroup behind the `child-process` hardening
 * options (`SpawnOptions.env`/`passEnv`, `uid`/`gid`, `cgroup`, `maxBuffer`).
 *
 * Every check runs when a runner or worker is constructed, so a host that
 * cannot honour an option says so at start-up rather than at the first job.
 * The measurements behind each one are in the comments beside it.
 */

/** `CAP_SETGID` and `CAP_SETUID`, as bit numbers in `/proc/self/status`. */
const CAP_SETGID = 6n;
const CAP_SETUID = 7n;

/**
 * Whether this process may start a child as another user and group.
 *
 * On Linux that is `CAP_SETUID` and `CAP_SETGID` in the effective set, which
 * root has and a process in a user namespace it owns has too; elsewhere,
 * being root. Measured on Bun 1.4.3: without them, `Bun.spawn({ uid })` for
 * any id but one's own throws `EPERM` from `posix_spawn`.
 */
export function canChangeIdentity(): boolean {
  if (process.platform === "linux") {
    try {
      const status = readFileSync("/proc/self/status", "utf8");
      const hex = /^CapEff:\s*([0-9a-f]+)$/im.exec(status)?.[1];
      if (hex !== undefined) {
        const caps = BigInt(`0x${hex}`);
        return (
          ((caps >> CAP_SETUID) & 1n) === 1n &&
          ((caps >> CAP_SETGID) & 1n) === 1n
        );
      }
    } catch {
      // No procfs: fall through to the uid check.
    }
  }
  return process.geteuid?.() === 0;
}

/** Whether a value is a non-negative integer id. */
function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Checks a child's spawn options, as plain JavaScript may have written them,
 * and throws a `ConfigError` for the first problem. `stdio` is the streams
 * after defaults, which `maxBuffer` depends on; `where` prefixes messages,
 * e.g. `"spawn."` or `'target { kind: "child-process" } spawn.'`.
 */
export function checkSpawnOptions(
  /** The options to check. */
  spawn: SpawnOptions | undefined,
  /** Where the child's stdout and stderr go once defaults are applied. */
  stdio: { stdout: string; stderr: string },
  /** A prefix for the messages, naming the option. */
  where = "spawn.",
): void {
  if (spawn === undefined) {
    return;
  }
  if (spawn === null || typeof spawn !== "object") {
    throw new ConfigError(`${where.replace(/\.$/, "")} must be an object`, {
      spawn: typeof spawn,
    });
  }

  checkChildEnv(spawn, where);
  checkIdentity(spawn, where);
  if (spawn.cgroup !== undefined) {
    checkCgroup(spawn.cgroup, where);
  }

  if (spawn.maxBuffer !== undefined) {
    if (
      typeof spawn.maxBuffer !== "number" ||
      !Number.isInteger(spawn.maxBuffer) ||
      spawn.maxBuffer < 1
    ) {
      throw new ConfigError(
        `${where}maxBuffer must be a positive whole number of bytes, not ${String(spawn.maxBuffer)}`,
        { maxBuffer: spawn.maxBuffer },
      );
    }
    if (stdio.stdout !== "pipe" && stdio.stderr !== "pipe") {
      throw new ConfigError(
        `${where}maxBuffer counts piped output, and neither stdout nor stderr is "pipe" (they are "${stdio.stdout}" and "${stdio.stderr}"): set one of them to "pipe"`,
        { maxBuffer: spawn.maxBuffer, ...stdio },
      );
    }
  }
}

/** Checks `uid` and `gid` against the platform and this process's privileges. */
function checkIdentity(spawn: SpawnOptions, where: string): void {
  const { uid, gid } = spawn;
  if (uid === undefined && gid === undefined) {
    return;
  }
  for (const [name, value] of [
    ["uid", uid],
    ["gid", gid],
  ] as const) {
    if (value !== undefined && !isId(value)) {
      throw new ConfigError(
        `${where}${name} must be a non-negative integer, not ${String(value)}`,
        { [name]: value },
      );
    }
  }
  if (process.platform === "win32") {
    throw new ConfigError(
      `${where}uid and gid are POSIX only: Bun fails the spawn with ENOTSUP on Windows`,
      { uid, gid, platform: process.platform },
    );
  }
  // Measured as root in a user namespace on Bun 1.4.3: `{ uid: 1000 }` alone
  // started the child with gid 0 and groups [0], the parent's. A child meant
  // to run as nobody would still be in the root group.
  if (uid !== undefined && gid === undefined) {
    throw new ConfigError(
      `${where}uid needs gid beside it: without one the child keeps this process's group (group 0, for a root parent)`,
      { uid },
    );
  }

  const same =
    (uid === undefined || uid === process.geteuid?.()) &&
    (gid === undefined || gid === process.getegid?.());
  if (!same && !canChangeIdentity()) {
    throw new ConfigError(
      `${where}uid/gid ${uid ?? "-"}:${gid ?? "-"} needs CAP_SETUID and CAP_SETGID (root), which this process (uid ${process.geteuid?.()}) does not have: the spawn would fail with EPERM`,
      { uid, gid, euid: process.geteuid?.() },
    );
  }
}

/** The controller each limit needs. */
const LIMIT_CONTROLLERS = {
  memory: "memory",
  pids: "pids",
  cpus: "cpu",
} as const;

/** Checks a `cgroup` option against the host: the directory and its controllers. */
function checkCgroup(cgroup: SpawnCgroupOptions, where: string): void {
  if (cgroup === null || typeof cgroup !== "object") {
    throw new ConfigError(
      `${where}cgroup must be { parent, limits? }, not ${String(cgroup)}`,
      { cgroup: String(cgroup) },
    );
  }
  // Bun ignores the option off Linux; a limit asked for and silently not
  // applied is the failure this check exists to prevent.
  if (process.platform !== "linux") {
    throw new ConfigError(
      `${where}cgroup is Linux only, and this is ${process.platform}`,
      { platform: process.platform },
    );
  }
  const { parent, limits = {} } = cgroup;
  if (typeof parent !== "string" || !isAbsolute(parent)) {
    throw new ConfigError(
      `${where}cgroup.parent must be an absolute path to a cgroup v2 directory, not ${String(parent)}`,
      { parent },
    );
  }
  // The values first: they need no host to be wrong.
  checkLimits(limits, where);

  // A cgroup v2 directory always has `cgroup.controllers`; a v1 hierarchy or
  // an ordinary directory does not.
  if (!existsSync(join(parent, "cgroup.controllers"))) {
    throw new ConfigError(
      `${where}cgroup.parent ${parent} is not a cgroup v2 directory (it has no cgroup.controllers)`,
      { parent },
    );
  }
  try {
    accessSync(parent, constants.W_OK);
  } catch {
    // Measured: joining a cgroup this user cannot write fails the spawn with
    // EACCES from clone3.
    throw new ConfigError(
      `${where}cgroup.parent ${parent} is not writable by this process (uid ${process.geteuid?.()}): delegate it, e.g. run under systemd-run --user --scope -p Delegate=yes`,
      { parent },
    );
  }

  const needed = Object.entries(LIMIT_CONTROLLERS)
    .filter(([limit]) => limits[limit as keyof typeof limits] !== undefined)
    .map(([, controller]) => controller);
  if (needed.length === 0) {
    return;
  }
  let enabled: string[];
  try {
    enabled = readFileSync(join(parent, "cgroup.subtree_control"), "utf8")
      .trim()
      .split(/\s+/);
  } catch {
    enabled = [];
  }
  const missing = needed.filter((controller) => !enabled.includes(controller));
  if (missing.length > 0) {
    throw new ConfigError(
      `${where}cgroup.parent ${parent} does not enable ${missing.join(", ")} for its children: write "${missing.map((c) => `+${c}`).join(" ")}" to its cgroup.subtree_control (and its parent's), after moving any process out of it`,
      { parent, missing, enabled },
    );
  }
}

/** Checks the values of `cgroup.limits`. */
function checkLimits(
  limits: NonNullable<SpawnCgroupOptions["limits"]>,
  where: string,
): void {
  if (limits === null || typeof limits !== "object") {
    throw new ConfigError(`${where}cgroup.limits must be an object`, {
      limits: String(limits),
    });
  }
  if (limits.memory !== undefined) {
    const bytes = parseByteSize(limits.memory);
    if (bytes === undefined || bytes < 1) {
      throw new ConfigError(
        `${where}cgroup.limits.memory must be a positive number of bytes or a size such as "256mb", not ${String(limits.memory)}`,
        { memory: limits.memory },
      );
    }
  }
  if (
    limits.pids !== undefined &&
    (!Number.isInteger(limits.pids) || limits.pids < 1)
  ) {
    throw new ConfigError(
      `${where}cgroup.limits.pids must be a positive integer, not ${String(limits.pids)}`,
      { pids: limits.pids },
    );
  }
  if (
    limits.cpus !== undefined &&
    (typeof limits.cpus !== "number" ||
      !Number.isFinite(limits.cpus) ||
      limits.cpus <= 0)
  ) {
    throw new ConfigError(
      `${where}cgroup.limits.cpus must be a positive number of CPUs, not ${String(limits.cpus)}`,
      { cpus: limits.cpus },
    );
  }
}

/** The `cpu.max` period, in microseconds: the kernel's default. */
const CPU_PERIOD = 100_000;

/**
 * Creates one child's cgroup under `cgroup.parent` and writes its limits;
 * returns its path. Throws what the filesystem threw, for the executor to
 * fail the run with.
 */
export function openChildCgroup(
  /** The option. */
  cgroup: SpawnCgroupOptions,
  /** The run the cgroup is for, made part of its name. */
  runId: string,
): string {
  const name = `bun-jobs-${runId.replace(/[^\w.-]/g, "_").slice(0, 64)}-${crypto.randomUUID().slice(0, 8)}`;
  const path = join(cgroup.parent, name);
  mkdirSync(path);
  try {
    const { memory, pids, cpus } = cgroup.limits ?? {};
    if (memory !== undefined) {
      writeFileSync(join(path, "memory.max"), String(parseByteSize(memory)));
      // The swap limit exists only with swap accounting on; without it there
      // is nothing to stretch the limit with, so its absence is fine.
      if (existsSync(join(path, "memory.swap.max"))) {
        writeFileSync(join(path, "memory.swap.max"), "0");
      }
    }
    if (pids !== undefined) {
      writeFileSync(join(path, "pids.max"), String(pids));
    }
    if (cpus !== undefined) {
      writeFileSync(
        join(path, "cpu.max"),
        `${Math.max(1_000, Math.round(cpus * CPU_PERIOD))} ${CPU_PERIOD}`,
      );
    }
  } catch (error) {
    rmdirQuietly(path);
    throw error;
  }
  return path;
}

/** How long {@link closeChildCgroup} keeps trying to remove a cgroup. */
const CGROUP_REMOVE_BUDGET = 2_000;

/**
 * Kills whatever is left in a child's cgroup — a process the job started and
 * did not wait for — and removes it. Bounded: a cgroup that will not go is
 * left behind (an empty directory, harmless) rather than holding the run's
 * outcome. Resolves `true` when it was removed. Never rejects.
 */
export async function closeChildCgroup(path: string): Promise<boolean> {
  try {
    // `cgroup.kill` (Linux 5.14+) SIGKILLs every process in the cgroup.
    if (existsSync(join(path, "cgroup.kill"))) {
      writeFileSync(join(path, "cgroup.kill"), "1");
    }
  } catch {
    // Already gone, or an older kernel: removal below says which.
  }
  const deadline = Date.now() + CGROUP_REMOVE_BUDGET;
  for (;;) {
    if (rmdirQuietly(path)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    // EBUSY while the killed processes are still being reaped.
    await sleep(10);
  }
}

/** Removes an empty cgroup directory; `true` when it is gone. */
function rmdirQuietly(path: string): boolean {
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT";
  }
}
