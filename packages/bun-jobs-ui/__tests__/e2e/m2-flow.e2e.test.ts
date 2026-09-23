/**
 * End-to-end, M2: the real app in headless Chrome (`Bun.WebView`, CDP)
 * manages a real queue through a real `createJobsApi` with CSRF on — pause
 * a queue from its screen, open a dead job and retry it — and every step is
 * read back from the API itself, not from the page. Each step also asserts
 * the page raised no CSP violation.
 *
 * Skips visibly without Chrome (`BUN_CHROME_PATH` overrides the search).
 */
import type { JobsApi } from "@kingsleyweb/bun-jobs";
import { existsSync } from "node:fs";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DEFAULT_ENTRY } from "../../lib/assets";
import { createJobsUi } from "../../lib/jobsUi";
import { chromeProfile } from "./profile";

/** Where Chrome may be, in search order. */
const CHROME_CANDIDATES = [
  process.env.BUN_CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => typeof path === "string" && path !== "");

const chromePath = CHROME_CANDIDATES.find((path) => existsSync(path));

/** The queue the flow manages. */
const QUEUE = "mail";

/** Page-side: resolves `true` once `selector` exists, `false` after `ms`. */
function waitForSelector(selector: string, ms: number): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const check = () => {
      if (document.querySelector(${JSON.stringify(selector)})) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  })`;
}

/**
 * Page-side: clicks the first enabled button whose text is `text` inside
 * `scope`, waiting up to `ms` for it. Resolves whether it clicked.
 */
function clickButton(scope: string, text: string, ms = 10_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const attempt = () => {
      for (const root of document.querySelectorAll(${JSON.stringify(scope)})) {
        for (const button of root.querySelectorAll("button")) {
          if (button.textContent.trim() === ${JSON.stringify(text)} && !button.disabled) {
            button.click();
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

/** Page-side: resolves whether an enabled button with `text` appears inside `scope` within `ms`. */
function hasButton(scope: string, text: string, ms = 5_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const check = () => {
      for (const root of document.querySelectorAll(${JSON.stringify(scope)})) {
        for (const button of root.querySelectorAll("button")) {
          if (button.textContent.trim() === ${JSON.stringify(text)} && !button.disabled) {
            return resolve(true);
          }
        }
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  })`;
}

/** Page-side: every CSP violation so far, buffered ones included. */
const COLLECT_VIOLATIONS = `new Promise((resolve) => {
  const observer = new ReportingObserver(() => {}, { types: ["csp-violation"], buffered: true });
  observer.observe();
  setTimeout(() => {
    const seen = observer.takeRecords().map((report) => String(report.body.effectiveDirective));
    observer.disconnect();
    resolve(seen);
  }, 50);
})`;

/** Polls `check` until it is true, or fails after `ms`. */
async function until(
  what: string,
  check: () => Promise<boolean>,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(50);
  }
}

describe.skipIf(chromePath === undefined)(
  `M2 flow in Chrome${chromePath === undefined ? " — SKIPPED: no Chrome found (set BUN_CHROME_PATH)" : ""}`,
  () => {
    let jobs: BunJobs;
    let api: JobsApi;
    let app: BunHttpAdapter;
    let origin: string;
    let view: Bun.WebView | undefined;
    /** The Chrome profile this suite owns, deleted with the view. */
    let profile: ReturnType<typeof chromeProfile> | undefined;
    let deadId: string;
    const pageConsole: string[] = [];

    /** A JSON read from the API, bypassing the page. */
    async function read<T>(path: string): Promise<T> {
      const response = await fetch(`${origin}/jobs-api${path}`);
      expect(response.status).toBe(200);
      return (await response.json()) as T;
    }

    beforeAll(async () => {
      jobs = new BunJobs({
        namespace: `ui-m2-e2e-${crypto.randomUUID().slice(0, 8)}`,
        driver: new MemoryDriver(),
        publishEvents: true,
        logger: noopLogger,
      });
      api = createJobsApi({
        jobs,
        basePath: "/jobs-api",
        mode: "jobs",
        authorize: () => true,
        csrf: { header: "x-bun-jobs-csrf" },
        limits: { queueCacheMs: 0 },
        logger: noopLogger,
      });
      const ui = createJobsUi(
        { api, title: "Jobs M2", dev: true, logger: noopLogger },
        { entry: DEFAULT_ENTRY },
      );
      app = new BunHttpAdapter();
      app.use(api.basePath, api.router);
      app.use(ui.basePath, ui.router);
      const server = await app.listen(0);
      origin = `http://127.0.0.1:${server.port}`;

      // One dead job (through a real worker), then two waiting ones.
      const queue = jobs.queue(QUEUE);
      const dead = await queue.add(
        "boom",
        { to: "a@example.com" },
        {
          attempts: 1,
        },
      );
      deadId = dead.id;
      const worker = jobs.worker(QUEUE, async () => {
        throw new Error("SMTP refused");
      });
      void worker.run();
      await until(
        "the job to die",
        async () => (await queue.count()).dead === 1,
      );
      await worker.close({ timeout: 1_000 });
      await queue.add("later", { index: 1 });
      await queue.add("later", { index: 2 });

      // Build before the browser asks, so the first page load is not the build.
      expect((await fetch(`${origin}/jobs`)).status).toBe(200);
      profile = chromeProfile("m2-flow");
      view = new Bun.WebView({
        backend: { type: "chrome", url: false, path: chromePath },
        // Chrome always writes a profile; owning the directory is what lets
        // this suite delete it (see `chromeProfile`).
        dataStore: profile.dataStore,
        width: 1280,
        height: 900,
        console: (type, ...args) => {
          pageConsole.push(`${type}: ${args.map(String).join(" ")}`);
        },
      });
    }, 60_000);

    afterAll(async () => {
      view?.close();
      await profile?.remove();
      await app?.close();
      await api?.close();
      await jobs?.close();
    });

    it("pauses the queue from its screen", async () => {
      await view!.navigate(`${origin}/jobs/queues/${QUEUE}`);
      const ready = await view!.evaluate<boolean>(
        waitForSelector('[data-testid="queue-total"]', 15_000),
      );
      if (!ready) {
        throw new Error(
          `the queue screen never loaded; console:\n${pageConsole.join("\n")}`,
        );
      }
      // The queue screen is a lazily loaded chunk; its stylesheet's rules
      // must still apply (they ship in the entry stylesheet).
      expect(
        await view!.evaluate<string>(
          `getComputedStyle(document.querySelector(".queue-header")).display`,
        ),
      ).toBe("flex");
      expect(
        await view!.evaluate<boolean>(
          clickButton('[role="group"][aria-label="Queue actions"]', "Pause"),
        ),
      ).toBe(true);
      await until(
        "the API to report the queue paused",
        async () =>
          (await read<{ paused: boolean }>(`/queues/${QUEUE}`)).paused,
      );
      // And the screen follows.
      expect(
        await view!.evaluate<boolean>(
          hasButton('[role="group"][aria-label="Queue actions"]', "Resume"),
        ),
      ).toBe(true);
      expect(await view!.evaluate<string[]>(COLLECT_VIOLATIONS)).toEqual([]);
    }, 30_000);

    it("retries a dead job from its screen", async () => {
      await view!.navigate(
        `${origin}/jobs/queues/${QUEUE}/jobs/${encodeURIComponent(deadId)}`,
      );
      expect(
        await view!.evaluate<boolean>(
          waitForSelector('[data-testid="job-screen"]', 15_000),
        ),
      ).toBe(true);
      expect(
        await view!.evaluate<boolean>(
          clickButton('[data-testid="job-screen"]', "Retry"),
        ),
      ).toBe(true);
      // The confirmation dialog's own Retry.
      expect(
        await view!.evaluate<boolean>(clickButton("dialog[open]", "Retry")),
      ).toBe(true);
      await until("the API to report the job retried", async () => {
        const job = await read<{ state: string }>(
          `/queues/${QUEUE}/jobs/${encodeURIComponent(deadId)}`,
        );
        return job.state !== "dead";
      });
      expect(await view!.evaluate<string[]>(COLLECT_VIOLATIONS)).toEqual([]);
    }, 30_000);
  },
);
