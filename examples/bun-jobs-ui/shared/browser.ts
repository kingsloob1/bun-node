import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * What the browser examples (`06-browser/`) share: deciding whether they can
 * run at all, starting headless Chrome through `Bun.WebView`, and page-side
 * helpers that wait on a condition rather than on time.
 *
 * Nothing here prints on import: `run-all.ts` recognises a skip by the
 * output *starting* with `skipped:`, so an example must decide before it
 * prints anything else.
 */

/** Prints the `skipped:` line `run-all.ts` looks for, and exits cleanly. */
export function skip(reason: string): never {
  console.log(`skipped: ${reason}`);
  process.exit(0);
}

/**
 * The Chrome to drive, or a skip: when `EXAMPLE_BROWSER=0`, when this Bun
 * has no `Bun.WebView`, or when no Chrome is found (`BUN_CHROME_PATH` first,
 * then the usual install paths).
 */
export function chromeOrSkip(): string {
  if (process.env.EXAMPLE_BROWSER === "0") {
    skip("EXAMPLE_BROWSER=0");
  }
  if (typeof (Bun as { WebView?: unknown }).WebView !== "function") {
    skip(`this Bun (${Bun.version}) has no Bun.WebView`);
  }
  const chromePath = [
    process.env.BUN_CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((path) => typeof path === "string" && path !== "" && existsSync(path));
  if (chromePath === undefined) {
    skip("no Chrome found (set BUN_CHROME_PATH)");
  }
  return chromePath;
}

/**
 * What every Chrome profile these examples make is named with, before the pid
 * of the process that owns it: `bun-jobs-ui-example-chrome-p<pid>-<random>`.
 * The pid is what lets a later run tell a profile nobody owns any more from
 * one still in use, and the shape matches the e2e suites' own profiles, so
 * either sweep can collect the other's leftovers and neither can take one
 * whose owner is alive.
 */
const PROFILE_PREFIX = "bun-jobs-ui-example-chrome-p";
/** A profile's name, with its owner's pid. */
const PROFILE_NAME = /^bun-jobs-ui-example-chrome-p(\d+)-[^-]+$/;

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

/** Deletes `directory`, never throwing: it is a temporary directory either way. */
function removeQuietly(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Nothing to do: a sweep must never fail the example that started it.
  }
}

/**
 * Removes the profiles an earlier run left behind: those whose owning process
 * has exited. A run killed before it exits cleanly leaves its profile, and a
 * departing Chrome writes a few last files after its owner has deleted it;
 * this is what collects both. Never one whose owner is alive.
 */
function sweepStaleProfiles(): void {
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    const owner = PROFILE_NAME.exec(name);
    if (
      owner &&
      Number(owner[1]) !== process.pid &&
      !isAlive(Number(owner[1]))
    ) {
      removeQuietly(join(tmpdir(), name));
    }
  }
}

/** This process's Chrome profile, once made: Chrome starts once per process. */
let profile: string | undefined;

/**
 * The Chrome profile directory for this process's views, made on first use.
 *
 * Without one, `Bun.WebView`'s Chrome backend makes its own,
 * `/tmp/.<hash>-00000000.bun-chrome`, which outlives `view.close()`: every
 * run of a browser example left one, a few hundred files each, and 670 of them
 * had built up in `/tmp` before this. A directory of our own is removed when
 * the process exits, and whatever a killed run or a late-writing Chrome leaves
 * is swept by the next run.
 */
function profileDirectory(): string {
  if (profile === undefined) {
    sweepStaleProfiles();
    const directory = mkdtempSync(
      join(tmpdir(), `${PROFILE_PREFIX}${process.pid}-`),
    );
    process.on("exit", () => removeQuietly(directory));
    profile = directory;
  }
  return profile;
}

/**
 * Starts a headless Chrome of its own (`url: false`: never one you have
 * open), recording the page's console into `pageConsole`. If Chrome will not
 * start, runs `cleanup` and skips.
 */
export async function openView(
  chromePath: string,
  pageConsole: string[],
  cleanup: () => Promise<void>,
): Promise<Bun.WebView> {
  try {
    const view = new Bun.WebView({
      backend: { type: "chrome", url: false, path: chromePath },
      // A profile this process owns and removes: see `profileDirectory`.
      dataStore: { directory: profileDirectory() },
      width: 1280,
      height: 900,
      console: (type, ...args) => {
        pageConsole.push(`${type}: ${args.map(String).join(" ")}`);
      },
    });
    await view.navigate("about:blank");
    return view;
  } catch (error) {
    await cleanup();
    skip(`Chrome at ${chromePath} did not start: ${String(error)}`);
  }
}

/** Page-side: resolves `true` once `selector` exists, `false` after `ms`. */
export function waitForSelector(selector: string, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      if (document.querySelector(${JSON.stringify(selector)})) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** Page-side: the trimmed text of `selector`, once it exists (or `null`). */
export function textOf(selector: string, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (element) return resolve(element.textContent.trim());
      if (Date.now() > deadline) return resolve(null);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/**
 * Page-side: finds the first enabled button whose text is `text` inside
 * `scope`, waiting up to `ms`. With `click`, clicks it. Resolves whether it
 * was found.
 */
export function button(
  scope: string,
  text: string,
  click: boolean,
  ms = 10_000,
): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const attempt = () => {
      for (const root of document.querySelectorAll(${JSON.stringify(scope)})) {
        for (const candidate of root.querySelectorAll("button")) {
          if (candidate.textContent.trim() === ${JSON.stringify(text)} && !candidate.disabled) {
            if (${click}) candidate.click();
            return resolve(true);
          }
        }
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(attempt, 50);
    };
    attempt();
  })`;
}
