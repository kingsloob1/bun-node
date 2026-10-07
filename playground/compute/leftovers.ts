import process from "node:process";

/**
 * Units a previous incarnation of **this same process** left running: what a
 * `bun --watch` reload (`cd playground && bun run dev`) leaves behind.
 *
 * `--watch` re-executes the playground in place, with the same pid, and runs
 * none of its shutdown: no signal arrives, and no `exit` handler runs, so
 * neither `localCompute()`'s host guard nor the playground's `shutdown()` gets
 * to stop the units. They are detached (each leads a process group of its
 * own), so they keep running as children of the new incarnation, which knows
 * nothing of them: measured, four old units still running after a reload, a
 * `ledger` replica among them able to run for up to its hour-long lifetime.
 *
 * So the playground looks for them as it starts, before it summons anything:
 * a child of this pid running one of the unit entries can only be an earlier
 * incarnation's. Each is sent `SIGTERM` (to its whole process group), which
 * `runSummoned` answers by closing its worker and exiting 0, and `SIGKILL`
 * once `graceMs` has passed. Units in a cgroup are also killed with it
 * (`cgroup.ts`).
 *
 * It reads the process table with `ps` (Linux and macOS). A unit that has
 * exited stays a zombie child of this process until it ends: harmless, and
 * not counted.
 */

/** One process from the table. */
interface ProcessRow {
  /** Its pid. */
  pid: number;
  /** Its parent's pid. */
  ppid: number;
  /** Its state; `Z…` is a zombie. */
  stat: string;
  /** Its command line. */
  args: string;
}

/** The process table: every process's pid, parent, state and command line. */
function processTable(): ProcessRow[] {
  const result = Bun.spawnSync({
    cmd: ["ps", "-ww", "-eo", "pid=,ppid=,stat=,args="],
    // An explicit environment: with none, Bun.spawn passes the one this
    // process started with, not the live one.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
    stdout: "pipe",
    stderr: "ignore",
  });
  if (!result.success) {
    return [];
  }
  return result.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      // `pid ppid stat args…`: three fields, then the rest of the line.
      const fields: string[] = [];
      let rest = line.trimStart();
      for (let index = 0; index < 3; index++) {
        const space = rest.search(/\s/);
        if (space <= 0) {
          return [];
        }
        fields.push(rest.slice(0, space));
        rest = rest.slice(space).trimStart();
      }
      const [pid, ppid, stat] = fields as [string, string, string];
      return [{ pid: Number(pid), ppid: Number(ppid), stat, args: rest }];
    });
}

/** This process's live children whose command line runs one of `entries`. */
function leftovers(entries: readonly string[]): number[] {
  return processTable()
    .filter(
      (row) =>
        row.ppid === process.pid &&
        !row.stat.startsWith("Z") &&
        entries.some((entry) => row.args.includes(entry)),
    )
    .map((row) => row.pid);
}

/** Signals a unit's whole process group, or the unit alone if that fails. */
function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(-pid, name);
  } catch {
    try {
      process.kill(pid, name);
    } catch {
      // Gone already.
    }
  }
}

/**
 * Stops every unit an earlier incarnation of this process left running, and
 * resolves once each has exited, with how many there were.
 */
export async function stopLeftoverUnits(
  /** The unit entries' absolute paths. */
  entries: readonly string[],
  /** How long a unit has after `SIGTERM` before `SIGKILL`, in ms. */
  graceMs = 5_000,
): Promise<number> {
  const found = leftovers(entries);
  if (found.length === 0) {
    return 0;
  }
  for (const pid of found) {
    signal(pid, "SIGTERM");
  }
  const deadline = Date.now() + graceMs;
  let left = found;
  while (left.length > 0 && Date.now() < deadline) {
    await Bun.sleep(100);
    const still = new Set(leftovers(entries));
    left = left.filter((pid) => still.has(pid));
  }
  for (const pid of left) {
    signal(pid, "SIGKILL");
  }
  // A SIGKILL is not ignorable; wait (briefly) to see it land.
  const reaped = Date.now() + 2_000;
  while (left.length > 0 && Date.now() < reaped) {
    await Bun.sleep(50);
    const still = new Set(leftovers(entries));
    left = left.filter((pid) => still.has(pid));
  }
  return found.length;
}
