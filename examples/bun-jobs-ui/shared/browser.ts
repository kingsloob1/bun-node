import { existsSync } from "node:fs";
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
