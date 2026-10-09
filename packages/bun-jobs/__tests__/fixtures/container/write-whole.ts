import { readFileSync } from "node:fs";
import process from "node:process";
import { writeWhole } from "../../../lib/runner/bootstrap/container-frames";

/**
 * Not a processor: a script that writes `argv[2]` bytes to its stdout with
 * `writeWhole`, giving up after `argv[3]` ms of a full pipe, and reports on
 * stderr whether its stdout was non-blocking and how the write ended. A
 * processor's `process.stdout.write` makes the shared pipe non-blocking (a
 * Bun behaviour), so the runner's writes meet `EAGAIN` whenever the worker
 * reads slower than they come; this does the same to itself first.
 */
const bytes = Number(process.argv[2]);
const patience = Number(process.argv[3]);
process.stdout.write("");
let nonBlocking = "unknown";
try {
  const flags = readFileSync("/proc/self/fdinfo/1", "utf8")
    .split("\n")
    .find((line) => line.startsWith("flags:"))!;
  nonBlocking = String(
    (Number.parseInt(flags.split(/\s+/)[1]!, 8) & 0o4000) !== 0,
  );
} catch {
  // No /proc: not Linux.
}
process.stderr.write(`nonblocking=${nonBlocking}\n`);
try {
  writeWhole(1, "y".repeat(bytes), patience);
  process.stderr.write("written\n");
} catch (error) {
  process.stderr.write(`threw: ${(error as Error).message}\n`);
  process.exit(3);
}
