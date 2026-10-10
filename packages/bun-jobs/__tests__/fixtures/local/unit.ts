import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import process from "node:process";
import { summonedFromArgs } from "../../../lib/index";

/**
 * A unit `localCompute` starts in its tests (`provider/local-compute.test.ts`).
 * Its behaviour is its first argument (the config's `args`), never the
 * environment, which is what several tests inspect:
 *
 * `unit.ts <mode> <report-file> [--bun-jobs-summon-*=…]`
 *
 * It first installs its mode's stop-signal handlers, then writes
 * `<report-file>` as JSON: its pid, its whole argv, its environment and what
 * `summonedFromArgs()` reads. The report is the test's "up" signal, so
 * nothing it promises may come after it: a new mode installs its handlers in
 * the loop above the write, never in its case below. A stop signal sent once
 * the report exists then always meets the handler, never the default action,
 * which would kill the unit with 130 or 143 and log nothing (a cancel test
 * failed so under `bun test --parallel=16`). Then, by mode:
 *
 * - `exit`: exits 0;
 * - `sleep`: waits; on SIGTERM or SIGINT appends `signal <name>` to
 *   `<report-file>.log` and exits 0;
 * - `stubborn`: ignores SIGTERM and SIGINT (appending them to the log) and
 *   waits for a SIGKILL;
 * - `crash`: writes two lines to stderr and exits 3;
 * - `chatty`: writes two lines to stdout and two to stderr, and exits 0;
 * - `hog`: allocates 640 MiB, 16 MiB at a time, and exits 0 if it can;
 * - `selfkill`: sends itself `SIGKILL` after 300 ms;
 * - `spawner`: starts `sleep 987` (appending `child <pid>` to the log), then
 *   waits as `sleep` does, exiting 0 on a stop signal without touching it;
 * - `stubborn-spawner`: starts `sleep 987` likewise, then waits as
 *   `stubborn` does;
 * - `trap-spawner`: starts `sleep 987` with `SIGTERM` ignored (a tool that
 *   handles the stop signal), logs `child <pid>`, and exits 0 on a stop
 *   signal itself;
 * - `subcgroup`: makes a cgroup `inner` inside its own, starts `sleep 987`
 *   in it (appending `child <pid>` and `cgroup <path>` to the log), and
 *   exits 0, leaving both behind.
 */

const [mode, report] = process.argv.slice(2);
if (report === undefined) {
  throw new Error("usage: unit.ts <mode> <report-file>");
}
const log = (line: string): void => {
  appendFileSync(`${report}.log`, `${line}\n`);
};

// Before the report: see above.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  switch (mode) {
    case "sleep":
    case "spawner":
    case "trap-spawner":
      // `spawner` leaves its child behind on purpose: the provider must not.
      process.on(signal, () => {
        log(`signal ${signal}`);
        process.exit(0);
      });
      break;
    case "stubborn":
      process.on(signal, () => log(`ignored ${signal}`));
      break;
    case "stubborn-spawner":
      process.on(signal, () => log(`signal ${signal}`));
      break;
  }
}

writeFileSync(
  report,
  JSON.stringify({
    pid: process.pid,
    argv: process.argv.slice(2),
    env: process.env,
    summon: summonedFromArgs() ?? null,
  }),
);
switch (mode) {
  case "exit":
    process.exit(0);
    break;
  case "sleep":
  case "stubborn":
    setInterval(() => {}, 1 << 30);
    break;
  case "crash":
    // Synchronous writes: an exit right after must not lose them.
    writeSync(2, "loading the GPU driver\n");
    writeSync(2, "fatal: cannot open libvk.so.1\n");
    process.exit(3);
    break;
  case "chatty":
    writeSync(1, "out one\nout two\n");
    writeSync(2, "err one\nerr two\n");
    process.exit(0);
    break;
  case "hog": {
    const held: Uint8Array[] = [];
    for (let index = 0; index < 40; index++) {
      held.push(new Uint8Array(16 * 1024 * 1024).fill(1));
    }
    log(`held ${held.length}`);
    process.exit(0);
    break;
  }
  case "selfkill":
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 300);
    setInterval(() => {}, 1 << 30);
    break;
  case "spawner":
  case "stubborn-spawner": {
    // A plain child: in this unit's process group, as a job's tool would be.
    const child = Bun.spawn({
      cmd: ["sleep", "987"],
      env: { PATH: process.env.PATH ?? "" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    log(`child ${child.pid}`);
    setInterval(() => {}, 1 << 30);
    break;
  }
  case "trap-spawner": {
    const child = Bun.spawn({
      cmd: ["sh", "-c", "trap '' TERM; exec sleep 987"],
      env: { PATH: process.env.PATH ?? "" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    log(`child ${child.pid}`);
    setInterval(() => {}, 1 << 30);
    break;
  }
  case "subcgroup": {
    const own = readFileSync("/proc/self/cgroup", "utf8")
      .trim()
      .split("\n")
      .find((line) => line.startsWith("0::"))!
      .slice(3);
    const inner = `/sys/fs/cgroup${own}/inner`;
    mkdirSync(inner);
    const child = Bun.spawn({
      cmd: ["sleep", "987"],
      env: { PATH: process.env.PATH ?? "" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      cgroup: inner,
    });
    log(`child ${child.pid}`);
    log(`cgroup /sys/fs/cgroup${own}`);
    process.exit(0);
    break;
  }
  default:
    throw new Error(`unknown mode ${mode}`);
}
