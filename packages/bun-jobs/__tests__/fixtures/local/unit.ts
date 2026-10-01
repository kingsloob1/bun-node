import { appendFileSync, writeFileSync, writeSync } from "node:fs";
import process from "node:process";
import { summonedFromArgs } from "../../../lib/index";

/**
 * A unit `localCompute` starts in its tests (`provider/local-compute.test.ts`).
 * Its behaviour is its first argument (the config's `args`), never the
 * environment, which is what several tests inspect:
 *
 * `unit.ts <mode> <report-file> [--bun-jobs-summon-*=…]`
 *
 * It first writes `<report-file>` as JSON: its pid, its whole argv, its
 * environment and what `summonedFromArgs()` reads. Then, by mode:
 *
 * - `exit`: exits 0;
 * - `sleep`: waits; on SIGTERM or SIGINT appends `signal <name>` to
 *   `<report-file>.log` and exits 0;
 * - `stubborn`: ignores SIGTERM and SIGINT (appending them to the log) and
 *   waits for a SIGKILL;
 * - `crash`: writes two lines to stderr and exits 3;
 * - `chatty`: writes two lines to stdout and two to stderr, and exits 0;
 * - `hog`: allocates 640 MiB, 16 MiB at a time, and exits 0 if it can.
 */

const [mode, report] = process.argv.slice(2);
if (report === undefined) {
  throw new Error("usage: unit.ts <mode> <report-file>");
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
const log = (line: string): void => {
  appendFileSync(`${report}.log`, `${line}\n`);
};

switch (mode) {
  case "exit":
    process.exit(0);
    break;
  case "sleep":
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        log(`signal ${signal}`);
        process.exit(0);
      });
    }
    setInterval(() => {}, 1 << 30);
    break;
  case "stubborn":
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => log(`ignored ${signal}`));
    }
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
  default:
    throw new Error(`unknown mode ${mode}`);
}
