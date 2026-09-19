/**
 * End-to-end, responsive: the real app in headless Chrome (`Bun.WebView`)
 * at 360px wide — a small phone — never scrolls the PAGE sideways. Wide
 * content (the queue and jobs tables, the docs' code) must scroll inside its
 * own container instead. happy-dom has no layout, so only a browser can
 * check this.
 *
 * Each screen is measured with `document.scrollingElement.scrollWidth <=
 * innerWidth`; a failure names the elements that stick out past the right
 * edge, outermost first, so the fix is findable.
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

/** The viewport width checked: a small phone. */
const WIDTH = 360;

/** The queue the screens show, with a long name to stress the header. */
const QUEUE = "transactional-emails-eu-west";

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

/** What {@link MEASURE} returns. */
interface Measure {
  /** `innerWidth`. */
  viewport: number;
  /** The page's scroll width. */
  scrollWidth: number;
  /** Elements whose right edge passes the viewport, outside any scroll container of their own. */
  offenders: string[];
}

/**
 * Page-side: the page's scroll width against the viewport, and the elements
 * poking out. An element inside a container that scrolls horizontally is
 * fine (that is the point of the container), so it is not listed.
 */
const MEASURE = `(() => {
  const viewport = window.innerWidth;
  const scrollWidth = document.scrollingElement.scrollWidth;
  const clipped = (element) => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) return true;
    }
    return false;
  };
  const describe = (element) =>
    element.tagName.toLowerCase() +
    (element.id ? "#" + element.id : "") +
    (element.className && typeof element.className === "string"
      ? "." + element.className.trim().split(/\\s+/).join(".")
      : "") +
    " (right " + Math.round(element.getBoundingClientRect().right) + ")";
  const offenders = [];
  for (const element of document.body.querySelectorAll("*")) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.right > viewport + 0.5 && !clipped(element)) {
      offenders.push(describe(element));
    }
  }
  return { viewport, scrollWidth, offenders: offenders.slice(0, 12) };
})()`;

describe.skipIf(chromePath === undefined)(
  `responsive at ${WIDTH}px in Chrome${chromePath === undefined ? " — SKIPPED: no Chrome found (set BUN_CHROME_PATH)" : ""}`,
  () => {
    let jobs: BunJobs;
    let api: JobsApi;
    let app: BunHttpAdapter;
    let origin: string;
    let view: Bun.WebView | undefined;
    const pageConsole: string[] = [];

    beforeAll(async () => {
      jobs = new BunJobs({
        namespace: `ui-responsive-e2e-${crypto.randomUUID().slice(0, 8)}`,
        driver: new MemoryDriver(),
        publishEvents: true,
        logger: noopLogger,
      });
      api = createJobsApi({
        jobs,
        basePath: "/jobs-api",
        mode: "jobs",
        authorize: () => true,
        websocket: {},
        limits: { queueCacheMs: 0 },
        logger: noopLogger,
      });
      const ui = createJobsUi(
        { api, title: "Jobs responsive", dev: true, logger: noopLogger },
        { entry: DEFAULT_ENTRY },
      );
      app = new BunHttpAdapter();
      app.use(api.basePath, api.router);
      app.use(ui.basePath, ui.router);
      api.websocket?.attach(app);
      const server = await app.listen(0);
      origin = `http://127.0.0.1:${server.port}`;

      const queue = jobs.queue(QUEUE);
      for (let index = 0; index < 3; index++) {
        await queue.add("send-a-rather-long-job-name", {
          to: `someone-${index}@example.com`,
        });
      }

      expect((await fetch(`${origin}/jobs`)).status).toBe(200);
      view = new Bun.WebView({
        backend: { type: "chrome", url: false, path: chromePath },
        width: WIDTH,
        height: 740,
        console: (type, ...args) => {
          pageConsole.push(`${type}: ${args.map(String).join(" ")}`);
        },
      });
    }, 60_000);

    afterAll(async () => {
      view?.close();
      await app?.close();
      await api?.close();
      await jobs?.close();
    });

    /** Opens `path`, waits for `ready`, and asserts nothing scrolls the page sideways. */
    async function expectNoSidewaysScroll(path: string, ready: string) {
      await view!.navigate(`${origin}/jobs${path}`);
      const shown = await view!.evaluate<boolean>(
        waitForSelector(ready, 15_000),
      );
      if (!shown) {
        throw new Error(
          `${path}: ${ready} never appeared; page console:\n${pageConsole.join("\n")}`,
        );
      }
      const measure = await view!.evaluate<Measure>(MEASURE);
      expect(measure.viewport).toBe(WIDTH);
      if (measure.scrollWidth > measure.viewport) {
        throw new Error(
          `${path}: the page is ${measure.scrollWidth}px wide in a ${measure.viewport}px viewport; sticking out:\n${measure.offenders.join("\n")}`,
        );
      }
    }

    it("the Overview fits", async () => {
      await expectNoSidewaysScroll("/", `[data-testid="queue-row-${QUEUE}"]`);
    }, 30_000);

    it("a queue screen fits: its jobs table scrolls in its own container", async () => {
      await expectNoSidewaysScroll(
        `/queues/${QUEUE}`,
        '[data-testid^="job-row-"]',
      );
      // The table is wider than the phone, and scrolls inside its region.
      const table = await view!.evaluate<{ scroll: number; client: number }>(
        `(() => { const wrap = document.querySelector(".table-wrap"); return { scroll: wrap.scrollWidth, client: wrap.clientWidth }; })()`,
      );
      expect(table.scroll).toBeGreaterThan(table.client);
    }, 30_000);

    it("the HTTP docs fit, on the index and on an operation", async () => {
      await expectNoSidewaysScroll("/docs/http", "a.http-op-link");
      await expectNoSidewaysScroll(
        "/docs/http/pauseQueue",
        '[data-testid="http-operation"]',
      );
    }, 30_000);

    it("the WebSocket docs fit", async () => {
      await expectNoSidewaysScroll("/docs/ws", '[data-testid="ws-main"]');
    }, 30_000);

    it("the Events console fits", async () => {
      await expectNoSidewaysScroll("/events", '[data-testid="events-screen"]');
    }, 30_000);

    it("negative control: an element wider than the phone is caught and named", async () => {
      await view!.navigate(`${origin}/jobs/events`);
      await view!.evaluate<boolean>(
        waitForSelector('[data-testid="events-screen"]', 15_000),
      );
      const measure = await view!.evaluate<Measure>(`(() => {
        const wide = document.createElement("div");
        wide.className = "too-wide";
        wide.style.width = "600px";
        wide.style.height = "1px";
        document.querySelector("main").appendChild(wide);
        return ${MEASURE};
      })()`);
      expect(measure.scrollWidth).toBeGreaterThan(measure.viewport);
      expect(measure.offenders.some((line) => line.includes("too-wide"))).toBe(
        true,
      );
    }, 30_000);
  },
);
