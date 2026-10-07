import type { Logger, UnitStatus } from "../../provider/index";
import type { LocalComputeConfig } from "./config";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { allowlisted } from "./config";

/**
 * `localCompute`'s units: the child processes it started, their output, how
 * they are stopped, and the host-wide guard that leaves none behind when the
 * host exits or is signalled.
 */

/** Why a unit was stopped by this host, when it was. */
export type StopReason = "cancelled" | "host-shutdown";

/** One child process this host started. */
export interface LocalUnit {
  /** The handle `summon` answered for it: `local-<pid>-<nonce>-<n>`. */
  readonly handle: string;
  /** The process. */
  readonly proc: Bun.Subprocess<"ignore", "pipe" | "ignore", "pipe">;
  /** When it was started, epoch ms. */
  readonly startedAt: number;
  /** When its lifetime ends and it is sent the stop signal, epoch ms. */
  readonly expiresAt: number;
  /** The stop signal its provider uses. */
  readonly signal: "SIGTERM" | "SIGINT";
  /** The grace after the stop signal, in ms. */
  readonly graceMs: number;
  /** The last non-empty line it wrote to stderr, clipped. */
  lastStderr?: string;
  /** Why this host stopped it, when it did. */
  stopped?: StopReason;
  /** Set when its lifetime timer fired: what `status()` reads to say `max-lifetime`. */
  lifetimeExpired?: boolean;
  /** Its own cgroup, inside the configured one, when one is set. */
  readonly cgroup?: string;
  /** Resolves once the process has exited, with its code (`143` for SIGTERM, `137` for SIGKILL). */
  readonly exited: Promise<number>;
  /** Resolves once both output streams have ended: everything it wrote has been read. */
  readonly drained: Promise<void>;
  /** The exit code once it has exited. */
  exitCode?: number;
}

/** The longest stderr line `status()` reports, in characters. */
const DETAIL_MAX = 200;

/** The longest line the output pump buffers before cutting it, in bytes. */
const LINE_MAX = 16_384;

/**
 * How long after the lifetime's `SIGKILL` `Bun.spawn`'s own `timeout` kills
 * the unit's process, in ms: a last backstop for a host whose event loop is
 * too busy to run the lifetime timer. It reaches the process only, not its
 * group.
 */
const NATIVE_BACKSTOP_MS = 5_000;

/** A unit's state, as `status()` reports it. */
export function unitStatus(unit: LocalUnit): UnitStatus {
  if (unit.exitCode === undefined) {
    return { handle: unit.handle, state: "running" };
  }
  const code = unit.exitCode;
  if (code === 0) {
    return { handle: unit.handle, state: "exited", exitCode: 0 };
  }
  if (unit.stopped !== undefined) {
    return {
      handle: unit.handle,
      state: "exited",
      exitCode: code,
      detail: unit.stopped,
    };
  }
  const signal = unit.proc.signalCode;
  return {
    handle: unit.handle,
    state: "failed",
    exitCode: code,
    detail:
      unit.lifetimeExpired === true
        ? "max-lifetime"
        : (unit.lastStderr ?? (signal === null ? `exit ${code}` : signal)),
  };
}

/** Where one unit's lines go. */
interface LineSink {
  /** Writes one line (without its newline) from `stream`. */
  line: (stream: "stdout" | "stderr", text: string) => void;
  /** Releases what the sink holds, once both streams have ended. */
  close: () => void;
}

/**
 * The sink for a unit's output, per the config. `warnOnce` is told when a
 * file cannot be opened or written, so output is never dropped silently.
 */
function sinkFor(
  config: LocalComputeConfig,
  handle: string,
  warnOnce: (message: string, error: unknown) => void,
): LineSink {
  const output = config.output;
  switch (output.kind) {
    case "ignore":
      return { line: () => {}, close: () => {} };
    case "inherit":
      return {
        line: (stream, text) => {
          (stream === "stdout" ? process.stdout : process.stderr).write(
            `${text}\n`,
          );
        },
        close: () => {},
      };
    case "logger": {
      const logger: Logger = output.logger.child({ unit: handle });
      return {
        line: (stream, text) => {
          if (stream === "stdout") {
            logger.info(text, { stream });
          } else {
            logger.warn(text, { stream });
          }
        },
        close: () => {},
      };
    }
    case "file": {
      // Appended with O_APPEND, so units sharing the file never overwrite
      // each other; each line is one write.
      let fd: number | undefined;
      try {
        fd = openSync(output.path, "a");
      } catch (error) {
        fd = undefined;
        warnOnce(
          `localCompute cannot open its output file ${output.path}: units' output is dropped`,
          error,
        );
      }
      return {
        line: (_stream, text) => {
          if (fd !== undefined) {
            try {
              writeSync(fd, `${text}\n`);
            } catch (error) {
              // A full disk or a removed file: the unit carries on.
              warnOnce(
                `localCompute cannot write its output file ${output.path}: units' output is dropped`,
                error,
              );
            }
          }
        },
        close: () => {
          if (fd !== undefined) {
            closeSync(fd);
            fd = undefined;
          }
        },
      };
    }
  }
}

/** Reads a stream line by line until it ends. */
async function pump(
  stream: ReadableStream<Uint8Array>,
  onLine: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        onLine(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > LINE_MAX) {
        onLine(buffer);
        buffer = "";
      }
    }
  } catch {
    // The pipe broke: the process is gone, and its exit says why.
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    onLine(buffer);
  }
}

/** Every unit still running, across every configured `localCompute`: the host shutdown guard's list. */
const LIVE = new Set<LocalUnit>();

/** The host signals that stop every unit before the host goes. */
const HOST_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Whether the guard's listeners are installed. */
let guarded = false;

/** Whether a host signal is stopping every unit now: a second signal then kills at once. */
let stopping = false;

/** Whether a host signal has ever arrived in this process: from then on, summons start nothing. */
let signalled = false;

/**
 * Whether a host signal (`SIGINT`, `SIGTERM`, `SIGHUP`) has arrived while a
 * unit ran. From then on, for the rest of the process, a summon starts
 * nothing, even when an app listener keeps the host alive through a
 * shutdown of its own: a unit started then would be stopped at once, or be
 * left running when the app's shutdown ends with a `SIGKILL`.
 */
export function hostStopping(): boolean {
  return signalled;
}

/** Whether a unit's process has not exited yet: its pid, and so its group id, is still its own. */
function alive(unit: LocalUnit): boolean {
  return (
    unit.exitCode === undefined &&
    unit.proc.exitCode === null &&
    unit.proc.signalCode === null
  );
}

/**
 * Sends `signal` to everything a unit started: its process group (it is
 * spawned detached, as the group's leader), and with `SIGKILL` its own
 * cgroup, which also holds what left the group. The group is signalled only
 * while the unit is alive: once it has exited and been reaped, its group id
 * could be reused, so then only the cgroup (a path, not a number) is. Best
 * effort: what is already gone is not an error.
 */
export function signalUnit(unit: LocalUnit, signal: NodeJS.Signals): void {
  if (alive(unit)) {
    try {
      process.kill(-unit.proc.pid, signal);
    } catch {
      // The group could not be signalled: the leader, at least.
      try {
        unit.proc.kill(signal);
      } catch {
        // Gone.
      }
    }
  }
  if (signal === "SIGKILL" && unit.cgroup !== undefined) {
    killCgroup(unit.cgroup);
  }
}

/** `cgroup.kill` (Linux 5.14+): `SIGKILL` to every process in the cgroup and below. */
function killCgroup(path: string): void {
  try {
    if (existsSync(join(path, "cgroup.kill"))) {
      writeFileSync(join(path, "cgroup.kill"), "1");
    }
  } catch {
    // Already gone, or an older kernel: the process group was signalled.
  }
}

/**
 * Removes a unit's own cgroup and any cgroup the unit made inside it, deepest
 * first (`removeTree`: the `./provider` entry's `removeCgroupTree`), retrying
 * while the killed processes are reaped (`EBUSY`), at most `budgetMs`. Never
 * throws: a cgroup that will not go is left behind, empty or holding a stuck
 * process.
 */
async function removeCgroup(
  path: string,
  removeTree: (path: string) => boolean,
  budgetMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!removeTree(path) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
}

/** Kills everything every live unit started: the host is exiting and cannot wait. */
function onHostExit(): void {
  for (const unit of LIVE) {
    unit.stopped ??= "host-shutdown";
    signalUnit(unit, "SIGKILL");
  }
}

/**
 * A host signal: every unit is sent its stop signal and killed after its
 * grace, and no new unit starts. When this guard is the signal's only
 * listener, it owns the signal's default action too: it waits for the units
 * (at most the longest grace), then raises the signal again with its
 * listeners removed, so the host ends as it would have. Otherwise the host's
 * own listener decides when it ends, and `exit` kills whatever is left.
 * Either way, no summon starts a unit again in this process.
 */
function onHostSignal(signal: NodeJS.Signals): void {
  const units = [...LIVE];
  if (stopping) {
    // A second signal: no more waiting.
    onHostExit();
    unguard();
    process.kill(process.pid, signal);
    return;
  }
  stopping = true;
  signalled = true;
  const longest = Math.max(0, ...units.map((unit) => unit.graceMs));
  const stopped = Promise.all(
    units.map(async (unit) => await stopUnit(unit, "host-shutdown")),
  );
  const sole = process.listenerCount(signal) === 1;
  if (!sole) {
    void stopped.then(() => {
      stopping = false;
      if (LIVE.size === 0) {
        unguard();
      }
    });
    return;
  }
  void (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      stopped,
      new Promise<void>((done) => {
        timer = setTimeout(done, longest + 100);
      }),
    ]);
    clearTimeout(timer);
    onHostExit();
    unguard();
    process.kill(process.pid, signal);
  })();
}

/** Installs the guard's listeners: once, while any unit runs. */
function guard(): void {
  if (guarded) {
    return;
  }
  guarded = true;
  process.on("exit", onHostExit);
  for (const signal of HOST_SIGNALS) {
    process.on(signal, onHostSignal);
  }
}

/** Removes the guard's listeners: no unit runs, so the host's signals are its own again. */
function unguard(): void {
  if (!guarded) {
    return;
  }
  guarded = false;
  process.off("exit", onHostExit);
  for (const signal of HOST_SIGNALS) {
    process.off(signal, onHostSignal);
  }
}

/**
 * Sends a unit's process group its stop signal and, if the unit is still
 * running after its grace, `SIGKILL` to the group and its cgroup. Resolves
 * once the unit has exited. A unit already stopping keeps its first reason
 * and its first escalation timer.
 */
export async function stopUnit(
  unit: LocalUnit,
  reason: StopReason,
): Promise<number> {
  if (unit.exitCode !== undefined) {
    return unit.exitCode;
  }
  if (unit.stopped === undefined) {
    unit.stopped = reason;
    signalUnit(unit, unit.signal);
    const escalate = setTimeout(() => {
      if (unit.exitCode === undefined) {
        signalUnit(unit, "SIGKILL");
      }
    }, unit.graceMs);
    void unit.exited.then(() => clearTimeout(escalate));
  }
  return await unit.exited;
}

/** What {@link startUnit} needs beside the config. */
export interface UnitStart {
  /** The handle to give it. */
  handle: string;
  /** Its arguments after the entry and the config's `args`: the request's summon arguments. */
  argv: readonly string[];
  /** Its environment, already built. */
  env: Record<string, string>;
  /** The longest it may live, in ms: the request's `maxLifetimeMs`. */
  lifetimeMs: number;
  /** Called once it has exited. */
  onExit: (unit: LocalUnit) => void;
  /** Warns, once per configured instance, that its output could not be written. */
  warnOnce: (message: string, error: unknown) => void;
  /**
   * Runs `fn` in the configured instance's own async context, not the
   * calling `summon`'s: the lifetime timers belong to the unit, which
   * outlives the call (`AsyncResource.runInAsyncScope`).
   */
  instanceScope: <T>(fn: () => T) => T;
  /**
   * The `./provider` entry's `removeCgroupTree`, passed in: this module must
   * not import that entry at run time (it loads `../local.ts`, which loads
   * this module).
   */
  removeCgroupTree: (path: string) => boolean;
}

/**
 * Starts one unit. `Bun.spawn` throws synchronously when the process cannot
 * be started (a missing executable, a cgroup it cannot join), and that is
 * left to the caller to map.
 *
 * It is spawned **detached**, so it leads a process group of its own, and
 * with a cgroup configured, in a cgroup of its own inside it: every stop
 * reaches what it started, not only the unit's own process. Detached, it no
 * longer receives the terminal's Ctrl-C with the host; the host's guard
 * stops it instead.
 *
 * Its lifetime is a backstop behind `runSummoned`, which stops the worker
 * itself before its deadline: at `lifetimeMs` its group is sent the stop
 * signal, and `SIGKILL` after the grace, by timers that belong to the unit
 * and are cleared when it exits. `Bun.spawn`'s own `timeout` kills the
 * process {@link NATIVE_BACKSTOP_MS} later still, should the host's event
 * loop be too busy to run them. With a cgroup, what the unit left in it is
 * killed when it exits; without one, a process it started and left behind
 * in a group of its own outlives it.
 */
export function startUnit(
  config: LocalComputeConfig,
  start: UnitStart,
): LocalUnit {
  const sink = sinkFor(config, start.handle, start.warnOnce);
  const timeout = start.lifetimeMs + config.graceMs + NATIVE_BACKSTOP_MS;
  const now = Date.now();
  let cgroup: string | undefined;
  let proc: Bun.Subprocess<"ignore", "pipe" | "ignore", "pipe">;
  try {
    if (config.cgroup !== undefined) {
      // A leaf of the configured cgroup: its limits bind every unit
      // together, and this unit's processes can be killed as one.
      const leaf = join(config.cgroup, start.handle);
      // Ours only once made: a leaf that already exists (EEXIST) is someone
      // else's, and the catch below never removes it.
      mkdirSync(leaf);
      cgroup = leaf;
    }
    proc = Bun.spawn({
      // Under the allowlist, Bun must not load a `.env` from the unit's cwd
      // behind it.
      cmd: [
        config.bun,
        ...(allowlisted(config) ? ["--no-env-file"] : []),
        config.entry,
        ...config.args,
        ...start.argv,
      ],
      cwd: config.cwd,
      env: start.env,
      stdin: "ignore",
      stdout: config.output.kind === "ignore" ? "ignore" : "pipe",
      stderr: "pipe",
      timeout,
      killSignal: "SIGKILL",
      detached: true,
      ...(cgroup === undefined ? {} : { cgroup }),
    }) as Bun.Subprocess<"ignore", "pipe" | "ignore", "pipe">;
  } catch (error) {
    sink.close();
    if (cgroup !== undefined) {
      void removeCgroup(cgroup, start.removeCgroupTree, 0);
    }
    throw error;
  }
  let finish: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  let drainedNow: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    drainedNow = resolve;
  });
  const unit: LocalUnit = {
    handle: start.handle,
    proc,
    startedAt: now,
    expiresAt: now + start.lifetimeMs,
    signal: config.signal,
    graceMs: config.graceMs,
    exited,
    drained,
    ...(cgroup === undefined ? {} : { cgroup }),
  };
  const pumps: Promise<void>[] = [
    pump(proc.stderr, (text) => {
      if (text.trim().length > 0) {
        unit.lastStderr = text.trim().slice(0, DETAIL_MAX);
      }
      sink.line("stderr", text);
    }),
  ];
  if (proc.stdout instanceof ReadableStream) {
    pumps.push(pump(proc.stdout, (text) => sink.line("stdout", text)));
  }
  LIVE.add(unit);
  guard();
  let lifetimeKill: ReturnType<typeof setTimeout> | undefined;
  const lifetime = start.instanceScope(() => {
    const timer = setTimeout(() => {
      if (!alive(unit)) {
        return;
      }
      unit.lifetimeExpired = true;
      signalUnit(unit, unit.signal);
      lifetimeKill = setTimeout(() => {
        signalUnit(unit, "SIGKILL");
      }, unit.graceMs);
      lifetimeKill.unref();
    }, start.lifetimeMs);
    // The host's life is its own: a unit's timer never holds it open.
    timer.unref();
    return timer;
  });
  // The output ends on its own; a grandchild holding a pipe open only keeps
  // the sink (and a file) open longer. No timer is left for it.
  void Promise.all(pumps).then(() => {
    sink.close();
    drainedNow();
  });
  void proc.exited.then((code) => {
    clearTimeout(lifetime);
    clearTimeout(lifetimeKill);
    // What it left in its own cgroup goes with it: a path, so safe after the
    // reap, unlike its group id.
    if (cgroup !== undefined) {
      killCgroup(cgroup);
      void removeCgroup(cgroup, start.removeCgroupTree);
    } else if (unit.stopped !== undefined || unit.lifetimeExpired === true) {
      // It was being stopped, and it exited inside its grace: what it
      // started may ignore the stop signal, and the escalation below the
      // unit's own exit would never come. A group with members keeps its id
      // from being reused, so `-pid` still names this unit's group; an empty
      // one answers ESRCH. Without a cgroup, what left the group is beyond
      // reach.
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        // Empty: nothing was left.
      }
    }
    unit.exitCode = code;
    LIVE.delete(unit);
    if (LIVE.size === 0 && !stopping) {
      unguard();
    }
    start.onExit(unit);
    finish(code);
  });
  return unit;
}

/** Internal, for tests: how many units run across every configured instance, and whether the guard is installed. */
export function liveUnits(): {
  /** Units still running. */
  count: number;
  /** Whether the exit and signal listeners are installed. */
  guarded: boolean;
} {
  return { count: LIVE.size, guarded };
}
