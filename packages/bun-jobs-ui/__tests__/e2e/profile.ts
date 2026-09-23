import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long to wait between sweeps, for a closed Chrome to finish writing, ms. */
const CHROME_EXIT_MS = 300;

/** How many sweeps to make before leaving whatever Chrome is still writing. */
const CHROME_EXIT_SWEEPS = 6;

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

/**
 * Makes a fresh profile directory under the system temp directory.
 *
 * @param label A short name for the suite, to make a stray directory
 *   traceable to the suite that left it.
 */
export function chromeProfile(label: string): ChromeProfile {
  const directory = mkdtempSync(join(tmpdir(), `bun-jobs-ui-${label}-`));
  return {
    dataStore: { directory },
    remove: async () => {
      // A profile Chrome still holds open, or one already gone, must not
      // fail a suite that otherwise passed.
      const sweep = () => {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {
          // Nothing to do: the directory is temporary either way.
        }
      };
      for (let attempt = 0; attempt < CHROME_EXIT_SWEEPS; attempt++) {
        sweep();
        await Bun.sleep(CHROME_EXIT_MS);
        if (!existsSync(directory)) {
          return;
        }
      }
      // Chrome is still writing after every attempt: delete what is there
      // and leave it. A skeleton of a few KB is not worth failing a suite.
      sweep();
    },
  };
}
