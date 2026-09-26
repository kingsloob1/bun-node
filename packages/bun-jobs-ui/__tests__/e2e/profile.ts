import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** How long to wait between sweeps, for a closed Chrome to finish writing, ms. */
const CHROME_EXIT_MS = 300;

/** How many sweeps to make before leaving whatever Chrome is still writing. */
const CHROME_EXIT_SWEEPS = 6;

/** Every profile directory this helper makes starts with this. */
const PREFIX = "bun-jobs-ui-";

/**
 * A profile directory's name: `bun-jobs-ui-<label>-p<pid>-<random>`. The pid
 * is the test process that owns it, so a later run can tell a profile whose
 * owner is gone from one still in use.
 */
const OWNED = /^bun-jobs-ui-.+-p(\d+)-[^-]+$/;

/**
 * A profile in the format before the pid was added: one of the e2e suites'
 * own labels and a random suffix. Only these, so another `bun-jobs-ui-*`
 * temporary directory — an example's file-driver root, say — is never taken
 * for one.
 */
const LEGACY = /^bun-jobs-ui-(?:smoke|m2-flow|responsive)-[^-]+$/;

/**
 * How old a directory in the format before the pid was added must be before a
 * sweep removes it. It carries no owner to ask, so age is the only safe
 * signal, and no e2e suite runs for anything like a day.
 */
const LEGACY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * A Chrome profile directory an e2e suite owns and deletes.
 *
 * `Bun.WebView`'s Chrome backend always needs a `--user-data-dir`, and the
 * one it makes for `dataStore: "ephemeral"` outlives `view.close()`: a
 * `/tmp/.<hash>-00000000.bun-chrome` directory of ~130 MB is left behind by
 * every run. Four days of suites had left 667 of them, 21 GB, which filled
 * the machine's tmpfs until SQLite integration tests began failing with
 * `SQLITE_IOERR_SHMSIZE`.
 *
 * Passing a directory of our own (`dataStore: { directory }`) puts the
 * clean-up where the suite can do it. Nothing is shared between suites, so a
 * run is still as isolated as an ephemeral profile.
 *
 * **A run that never reaches its `afterAll` still leaves one.** A `bun test`
 * killed mid-suite takes its Chrome with it before `remove()` runs, leaving
 * the whole ~90 MB profile: 118 of those, 8.2 GB, had built up over four days
 * of interrupted runs and filled the tmpfs again. So each new profile first
 * sweeps the ones whose owning process has exited ({@link sweepStaleProfiles}),
 * which bounds the leak to the runs since the last e2e suite started.
 */
export interface ChromeProfile {
  /** What to pass as the view's `dataStore`. */
  dataStore: { directory: string };
  /**
   * Deletes the directory. Safe to call more than once, and never throws.
   *
   * Await it: `view.close()` returns before Chrome has finished exiting, and
   * a departing Chrome writes a few last files into its profile. One delete
   * leaves those behind — measured, an 8 KB skeleton per run — so this
   * deletes, waits, and deletes again.
   */
  remove: () => Promise<void>;
}

/** Whether a process with this pid is running (or exists but is not ours to signal). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // `EPERM`: it exists, under another user. Only `ESRCH` means gone.
    return (error as { code?: string }).code !== "ESRCH";
  }
}

/** Deletes `directory`, never throwing: a temporary directory either way. */
function removeQuietly(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Nothing to do: a sweep must not fail the suite that started it.
  }
}

/**
 * Removes the profile directories under `root` that no running process owns:
 * those tagged with the pid of a process that has exited, and the e2e suites'
 * own profiles in the untagged format once they are a day old. A directory whose owner is alive is kept,
 * whatever its age, so a sweep can never pull a profile out from under a
 * running suite. Returns the names it removed.
 *
 * @param root The directory profiles are made in. Defaults to the system
 *   temp directory.
 * @param now The current time, for the untagged format's age.
 */
export function sweepStaleProfiles(
  root = tmpdir(),
  now = Date.now(),
): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(PREFIX)) {
      continue;
    }
    const directory = join(root, name);
    const owner = OWNED.exec(name);
    let stale: boolean;
    if (owner) {
      const pid = Number(owner[1]);
      stale = pid !== process.pid && !isAlive(pid);
    } else if (LEGACY.test(name)) {
      try {
        const stats = statSync(directory);
        stale = stats.isDirectory() && now - stats.mtimeMs > LEGACY_MAX_AGE_MS;
      } catch {
        stale = false;
      }
    } else {
      stale = false;
    }
    if (stale) {
      removeQuietly(directory);
      removed.push(name);
    }
  }
  return removed;
}

/**
 * Makes a fresh profile directory, after sweeping the stale ones.
 *
 * @param label A short name for the suite, to make a stray directory
 *   traceable to the suite that left it.
 * @param root The directory to make it in. Defaults to the system temp
 *   directory; tests pass their own.
 */
export function chromeProfile(label: string, root = tmpdir()): ChromeProfile {
  sweepStaleProfiles(root);
  const directory = mkdtempSync(
    join(root, `${PREFIX}${label}-p${process.pid}-`),
  );
  return {
    dataStore: { directory },
    remove: async () => {
      // A profile Chrome still holds open, or one already gone, must not
      // fail a suite that otherwise passed.
      for (let attempt = 0; attempt < CHROME_EXIT_SWEEPS; attempt++) {
        removeQuietly(directory);
        await Bun.sleep(CHROME_EXIT_MS);
        if (!existsSync(directory)) {
          return;
        }
      }
      // Chrome is still writing after every attempt: delete what is there
      // and leave it. A skeleton of a few KB is not worth failing a suite;
      // the next run's sweep takes whatever remains, since this pid will be
      // gone by then.
      removeQuietly(directory);
    },
  };
}
