import type { Logger, UnitStatus } from "../../provider/index";
import type { LocalComputeConfig } from "./config";
import { closeSync, openSync, writeSync } from "node:fs";
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
  /** The handle `summon` answered for it: `local-<pid>-<n>`. */
  readonly handle: string;
  /** The process. */
  readonly proc: Bun.Subprocess<"ignore", "pipe" | "ignore", "pipe">;
  /** When it was started, epoch ms. */
  readonly startedAt: number;
  /** When the host-side lifetime backstop kills it, epoch ms. */
  readonly killAt: number;
  /** The stop signal its provider uses. */
  readonly signal: "SIGTERM" | "SIGINT";
  /** The grace after the stop signal, in ms. */
  readonly graceMs: number;
  /** The last non-empty line it wrote to stderr, clipped. */
  lastStderr?: string;
  /** Why this host stopped it, when it did. */
  stopped?: StopReason;
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
  const lifetime = signal === "SIGKILL" && Date.now() >= unit.killAt - 50;
  return {
    handle: unit.handle,
    state: "failed",
    exitCode: code,
    detail: lifetime
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

/** The sink for a unit's output, per the config. */
function sinkFor(config: LocalComputeConfig, handle: string): LineSink {
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
      } catch {
        fd = undefined;
      }
      return {
        line: (_stream, text) => {
          if (fd !== undefined) {
            try {
              writeSync(fd, `${text}\n`);
            } catch {
              // A full disk or a removed file: the unit carries on.
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

/** Whether a host signal has started stopping every unit. */
let stopping = false;

/** Kills every live unit at once: the host is exiting and cannot wait. */
function onHostExit(): void {
  for (const unit of LIVE) {
    unit.stopped ??= "host-shutdown";
    unit.proc.kill("SIGKILL");
  }
}

/**
 * A host signal: every unit is sent its stop signal and killed after its
 * grace. When this guard is the signal's only listener, it owns the
 * signal's default action too: it waits for the units (at most the longest
 * grace), then raises the signal again with its listeners removed, so the
 * host ends as it would have. Otherwise the host's own listener decides when
 * it ends, and `exit` kills whatever is left.
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
  const longest = Math.max(0, ...units.map((unit) => unit.graceMs));
  for (const unit of units) {
    void stopUnit(unit, "host-shutdown");
  }
  const sole = process.listenerCount(signal) === 1;
  if (!sole) {
    stopping = false;
    return;
  }
  void (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(units.map(async (unit) => await unit.exited)),
      new Promise<void>((done) => {
        timer = setTimeout(done, longest + 100);
      }),
    ]);
    clearTimeout(timer);
    onHostExit();
    unguard();
    stopping = false;
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
 * Sends a unit its stop signal and, if it is still running after its
 * grace, `SIGKILL`. Resolves once it has exited. A unit already stopping
 * keeps its first reason and its first escalation timer.
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
    unit.proc.kill(unit.signal);
    const escalate = setTimeout(() => {
      if (unit.exitCode === undefined) {
        unit.proc.kill("SIGKILL");
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
}

/**
 * Starts one unit. `Bun.spawn` throws synchronously when the process cannot
 * be started (a missing executable, a cgroup it cannot join), and that is
 * left to the caller to map.
 *
 * The lifetime is enforced by `Bun.spawn`'s own `timeout`: `SIGKILL` at the
 * lifetime plus the grace, a backstop behind `runSummoned`, which stops the
 * worker itself before its deadline. No timer is left in the host for it.
 */
export function startUnit(
  config: LocalComputeConfig,
  start: UnitStart,
): LocalUnit {
  const sink = sinkFor(config, start.handle);
  const timeout = start.lifetimeMs + config.graceMs;
  const now = Date.now();
  let proc: Bun.Subprocess<"ignore", "pipe" | "ignore", "pipe">;
  try {
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
      ...(config.cgroup === undefined ? {} : { cgroup: config.cgroup }),
    }) as Bun.Subprocess<"ignore", "pipe" | "ignore", "pipe">;
  } catch (error) {
    sink.close();
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
    killAt: now + timeout,
    signal: config.signal,
    graceMs: config.graceMs,
    exited,
    drained,
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
  // The output ends on its own; a grandchild holding a pipe open only keeps
  // the sink (and a file) open longer. No timer is left for it.
  void Promise.all(pumps).then(() => {
    sink.close();
    drainedNow();
  });
  void proc.exited.then((code) => {
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
