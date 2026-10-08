import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { isAlive } from "../backend";

/**
 * Units an earlier run left running, and how the next run stops them.
 *
 * Two ways a run ends without stopping its units:
 *
 * - **Killed outright** (`SIGKILL`, the OOM killer): no handler runs, so
 *   neither `localCompute()`'s host guard nor the playground's `shutdown()`
 *   stops anything. The units are detached (each leads a process group of
 *   its own), so they are re-parented and keep running: until idle, or, for
 *   a `ledger` replica (`until-stopped`), until its hour-long lifetime.
 * - **A `bun --watch` reload** (`bun run dev`) re-executes the playground in
 *   place, with the same pid, and runs no shutdown either; measured, four
 *   units of the earlier incarnation still running after a reload.
 *
 * So every run **records each unit it starts** — its pid, its start time and
 * its command line — in one file per checkout,
 * `os.tmpdir()/bun-node-playground-<hash of the checkout path>/units.pid`, a
 * line per unit tagged with the recording playground's pid. Not under
 * `.data/`: the memory backend writes nothing there. One per checkout, so two
 * worktrees never stop each other's units. A reboot clearing it is fine:
 * a reboot ends the units too.
 *
 * At startup, before anything is summoned, the playground reads it and stops
 * every recorded unit whose recorder is gone (killed) or is itself (a
 * reload): `SIGTERM` to the unit's process group, which `runSummoned`
 * answers by closing its worker and exiting 0, and `SIGKILL` once the grace
 * has passed. **Only a process whose pid, start time and command line all
 * match its record** is signalled, so a pid the system has since reused for
 * something else is never touched. Then those records are dropped; a still
 * running playground's records are kept. A clean stop drops its own.
 *
 * The process table comes from `ps` (Linux and macOS). A unit that has exited
 * but whose parent is this process stays a zombie until it ends: not counted.
 */

/** One process from the table. */
interface ProcessRow {
  /** Its pid. */
  pid: number;
  /** Its parent's pid. */
  ppid: number;
  /** Its state; `Z…` is a zombie. */
  stat: string;
  /** When it started, as `ps -o lstart` prints it (to the second, `LC_ALL=C`). */
  start: string;
  /** Its command line. */
  args: string;
}

/** One unit, as a run records it. */
export interface UnitPidRecord {
  /** The pid of the playground that started it. */
  owner: number;
  /** The unit's pid. */
  pid: number;
  /** The unit's start time, as `ps -o lstart` prints it. */
  start: string;
  /** The unit's command line. */
  args: string;
}

/** The process table: every process's pid, parent, state, start time and command line. */
function processTable(): ProcessRow[] {
  const result = Bun.spawnSync({
    cmd: ["ps", "-ww", "-eo", "pid=,ppid=,stat=,lstart=,args="],
    // An explicit environment: with none, Bun.spawn passes the one this
    // process started with, not the live one. `LC_ALL=C` fixes lstart's form.
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
      // `pid ppid stat` + five lstart fields (`Wed Oct  7 15:36:32 2026`),
      // then the rest of the line.
      const fields: string[] = [];
      let rest = line.trimStart();
      for (let index = 0; index < 8; index++) {
        const space = rest.search(/\s/);
        if (space <= 0) {
          return [];
        }
        fields.push(rest.slice(0, space));
        rest = rest.slice(space).trimStart();
      }
      const [pid, ppid, stat, ...start] = fields as [
        string,
        string,
        string,
        ...string[],
      ];
      return [
        {
          pid: Number(pid),
          ppid: Number(ppid),
          stat,
          start: start.join(" "),
          args: rest,
        },
      ];
    });
}

/**
 * The unit-pid file for the checkout at `checkout`:
 * `os.tmpdir()/bun-node-playground-<hash>/units.pid`.
 */
export function unitPidFilePath(checkout: string): string {
  const hash = new Bun.CryptoHasher("sha256")
    .update(checkout)
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), `bun-node-playground-${hash}`, "units.pid");
}

/** The records in `file`, skipping any line that does not parse. */
function readRecords(file: string): UnitPidRecord[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      const record = JSON.parse(line) as UnitPidRecord;
      return typeof record.pid === "number" &&
        typeof record.owner === "number" &&
        typeof record.start === "string" &&
        typeof record.args === "string"
        ? [record]
        : [];
    } catch {
      return [];
    }
  });
}

/**
 * Rewrites `file` without the records `drop` names, re-reading it first so a
 * line another playground of this checkout appended meanwhile is kept, and
 * replacing it in one rename. Removes it when nothing is left.
 */
function dropRecords(
  file: string,
  drop: (record: UnitPidRecord) => boolean,
): void {
  const kept = readRecords(file).filter((record) => !drop(record));
  if (kept.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    kept.map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  renameSync(temporary, file);
}

/** Records the units this run starts, in the checkout's unit-pid file. */
export class UnitPidFile {
  /** The units already recorded, as `pid start`. */
  readonly #recorded = new Set<string>();

  constructor(
    /** The file: {@link unitPidFilePath}. */
    readonly file: string,
    /** The unit entries' absolute paths: a child running one is a unit. */
    readonly entries: readonly string[],
  ) {}

  /**
   * Records every child of this process running a unit entry that is not
   * recorded yet. Called after each start that started something; the unit
   * is spawned by then, so it is in the table.
   */
  record(): void {
    const fresh = processTable().filter(
      (row) =>
        row.ppid === process.pid &&
        !row.stat.startsWith("Z") &&
        this.entries.some((entry) => row.args.includes(entry)) &&
        !this.#recorded.has(`${row.pid} ${row.start}`),
    );
    if (fresh.length === 0) {
      return;
    }
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      appendFileSync(
        this.file,
        fresh
          .map((row) =>
            JSON.stringify({
              owner: process.pid,
              pid: row.pid,
              start: row.start,
              args: row.args,
            } satisfies UnitPidRecord),
          )
          .map((line) => `${line}\n`)
          .join(""),
      );
      for (const row of fresh) {
        this.#recorded.add(`${row.pid} ${row.start}`);
      }
    } catch (error) {
      console.warn(
        `playground: could not record units in ${this.file}; a killed run's units would not be stopped by the next:`,
        error,
      );
    }
  }

  /** Drops this run's records: every unit it started has exited. */
  forgetMine(): void {
    try {
      dropRecords(this.file, (record) => record.owner === process.pid);
    } catch {
      // Left as it is: the next start checks every record against the table.
    }
  }
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

/** The records' units that still run: pid, start time and command line all match, and not a zombie. */
function matching(records: readonly UnitPidRecord[]): number[] {
  const table = new Map(processTable().map((row) => [row.pid, row]));
  return records.flatMap((record) => {
    const row = table.get(record.pid);
    return row !== undefined &&
      !row.stat.startsWith("Z") &&
      row.start === record.start &&
      row.args === record.args
      ? [record.pid]
      : [];
  });
}

/**
 * Stops every unit an earlier run recorded in `file` whose recorder is gone,
 * or is this process (a `--watch` reload), and resolves once each has exited,
 * with how many there were. Only a process matching its record's pid, start
 * time and command line is signalled. Drops those records afterwards.
 */
export async function stopRecordedUnits(
  /** The checkout's unit-pid file. */
  file: string,
  /** How long a unit has after `SIGTERM` before `SIGKILL`, in ms. */
  graceMs = 5_000,
): Promise<number> {
  const orphaned = (record: UnitPidRecord): boolean =>
    record.owner === process.pid || !isAlive(record.owner);
  const records = readRecords(file).filter(orphaned);
  if (records.length === 0) {
    return 0;
  }
  const found = matching(records);
  for (const pid of found) {
    signal(pid, "SIGTERM");
  }
  let left = found;
  const settle = async (until: number): Promise<void> => {
    while (left.length > 0 && Date.now() < until) {
      await Bun.sleep(100);
      const still = new Set(matching(records));
      left = left.filter((pid) => still.has(pid));
    }
  };
  await settle(Date.now() + graceMs);
  for (const pid of left) {
    signal(pid, "SIGKILL");
  }
  // A SIGKILL is not ignorable; wait (briefly) to see it land.
  await settle(Date.now() + 2_000);
  try {
    dropRecords(file, orphaned);
  } catch {
    // Left as it is: checked against the table again next time.
  }
  return found.length;
}
