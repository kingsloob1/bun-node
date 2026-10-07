import type { SummonRequest } from "../../../lib/provider/index";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { providerCallContext } from "../../../lib/provider/context";
import { localCompute } from "../../../lib/provider/index";

/**
 * A host for `localCompute`'s shutdown tests: starts two units, prints
 * `ready` once both have reported, then ends as its mode says, and the test
 * checks no unit outlived it.
 *
 * `host.ts <unit-mode> <dir> <host-mode> [graceMs]`
 *
 * - `<unit-mode>`: the units' mode (`sleep`, `stubborn`, `spawner`, …, see
 *   `unit.ts`); each reports to `<dir>/unit-<n>.json`, and `ready` waits for
 *   a spawner's child too.
 * - `<host-mode>`: `exit` calls `process.exit(0)`; `wait` waits for a
 *   signal with no listener of its own, so the guard owns the signal's
 *   default; `listen` adds its own `SIGTERM` listener, which prints
 *   `host-signal` and keeps the host alive; `throw` throws an uncaught error
 *   and `reject` leaves a rejection unhandled, 100 ms after `ready`;
 *   `summoning` waits like `wait`, and summons one more unit every 200 ms,
 *   printing each answer as `{"status":…,"at":…}`; `listen-summoning` does
 *   the same with its own `SIGTERM` listener (printing `host-signal`), so
 *   the host lives on after the signal.
 */

const [unitMode, dir, hostMode, grace] = process.argv.slice(2) as [
  string,
  string,
  string,
  string | undefined,
];
const graceMs = Number(grace ?? 500);
const context = providerCallContext(new AbortController().signal, noopLogger);

/** A request for unit `n`. */
function request(n: number): SummonRequest {
  return {
    namespace: "host-test",
    queue: "work",
    id: `sm_host${n}`,
    dedupeKey: `sm-host${n}`,
    count: 1,
    target: 1,
    demand: {
      at: Date.now(),
      paused: false,
      waiting: 1,
      dueNow: 0,
      stalled: 0,
      active: 0,
      workers: 0,
      nextDueAt: null,
      demand: 1,
      outstanding: 1,
      capped: false,
      exact: true,
    },
    reason: "manual",
    env: {},
    argv: [`--bun-jobs-summon-id=sm_host${n}`],
    maxLifetimeMs: 60_000,
  };
}

// The unit's mode and report file go first: the summon arguments follow.
const units = [1, 2].map((n) =>
  localCompute({
    entry: join(import.meta.dir, "unit.ts"),
    args: [unitMode, join(dir, `unit-${n}.json`)],
    output: "ignore",
    shutdown: { graceMs },
  }),
);
for (const [index, unit] of units.entries()) {
  await unit.summon.summon(request(index + 1), context);
}
/** Whether unit `n` is ready: it reported, and a spawner has started its child. */
function unitReady(n: number): boolean {
  const report = join(dir, `unit-${n}.json`);
  if (!existsSync(report)) {
    return false;
  }
  if (!unitMode.includes("spawner")) {
    return true;
  }
  const log = `${report}.log`;
  return existsSync(log) && readFileSync(log, "utf8").includes("child ");
}
while (![1, 2].every(unitReady)) {
  await Bun.sleep(20);
}
if (hostMode === "listen" || hostMode === "listen-summoning") {
  process.on("SIGTERM", () => {
    process.stdout.write("host-signal\n");
  });
}
process.stdout.write("ready\n");
if (hostMode === "exit") {
  process.exit(0);
}
if (hostMode === "throw") {
  setTimeout(() => {
    throw new Error("the host crashed");
  }, 100);
}
if (hostMode === "reject") {
  setTimeout(() => {
    void Promise.reject(new Error("the host's promise was rejected"));
  }, 100);
}
if (hostMode === "summoning" || hostMode === "listen-summoning") {
  let n = 2;
  setInterval(() => {
    n++;
    void units[0]!.summon.summon(request(n), context).then((answer) => {
      process.stdout.write(
        `${JSON.stringify({ status: answer.status, at: Date.now() })}\n`,
      );
    });
  }, 200);
}
setInterval(() => {}, 1 << 30);
