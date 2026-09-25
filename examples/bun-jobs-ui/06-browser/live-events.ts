/**
 * Live updates in a real browser: the header's live badge, the Events
 * console tailing a queue as a real worker completes a job, workers'
 * first-start and state rows, a `queue-discovered` gap for a queue another
 * process creates, the console's `types` filter read from the URL, and the
 * badge staying off, with its reason, on hosts that cannot, may not, or need
 * not connect.
 *
 * ```bash
 * bun 06-browser/live-events.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/live-events.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/live-events.ts   # skip on purpose
 * ```
 *
 * Like `pause-and-retry.ts`, it drives headless Chrome through `Bun.WebView`
 * and **skips** (prints `skipped:` and exits 0) when there is no
 * `Bun.WebView`, no Chrome, or Chrome will not start.
 *
 * Five hosts over one set of jobs, and a sixth over a file driver, each an
 * API and the UI on its own port:
 *
 * | Host        | API                                     | Badge                        |
 * |-------------|-----------------------------------------|------------------------------|
 * | `live`      | a socket, attached; `authorize` says yes | `live`                      |
 * | `socketless`| `websocket: false`                      | `off`: no socket             |
 * | `refused`   | a socket, but `events.connect` refused  | `off`: may not connect       |
 * | `silent`    | a socket, but nothing publishes events  | `off`: nothing publishes     |
 * | `docsOnly`  | as `live`, but the UI is `sections: { manage: false }` | `off`, "Live off": documentation only |
 * | `cross`     | as `live`, over a file driver a child process shares | `live`             |
 *
 * What makes it work:
 *
 * - **Producers must publish.** The socket carries what the `BunJobs` context
 *   publishes, so the jobs here are built with `publishEvents: true`. The
 *   `silent` host's context is not, and its API says `publishing: false` in
 *   `/meta`.
 * - **The socket must be attached.** `createJobsApi()` builds it (unless
 *   `websocket: false`); `api.websocket.attach(app)` registers the upgrade on
 *   the host. `/meta`'s `websocket` then names its path, and the app opens one
 *   connection for the whole page, offering the `bun-jobs.v1` subprotocol.
 * - **The client never tries what it cannot do.** With no socket, with
 *   `events.connect` refused in the untargeted `/meta/permissions`, or with
 *   events that are only this process's own (`events: "local"`, as on the
 *   memory driver used here) *and* nobody publishing, the badge is `off` and
 *   its tooltip says why. No upgrade is attempted: this example counts them.
 * - **A docs-only UI opens no socket.** Mounted with `sections: { manage:
 *   false }` it has no screen that live events would refresh, so even over
 *   an API that could serve them the badge is `off` and reads `Live off`, not
 *   `Polling 5s`: nothing on a docs-only UI polls either. Its tooltip says
 *   "Live updates are off: this UI shows documentation only", and the host
 *   sees no upgrade.
 * - **Workers have two scopes of their own.** "Every worker (workers)" is
 *   the `workers` channel, "One queue's workers" is `queue/<queue>/workers`;
 *   each carries a worker's `state`, `config` and `control` events (`kind`
 *   `worker`, `target` the queue). A worker announces its first `run()`
 *   with one `state` event carrying no `previous`: `running`; `paused` when
 *   it was paused before `run()`; `stopped` (reason "stopped persistently")
 *   when a stop recorded against its key holds it. Every later change (a
 *   pause, a resume, a stop, a restart, a config change) carries
 *   `previous`. The rows here come from real workers, and a worker of
 *   another queue never shows on one queue's scope.
 * - **A queue another process creates arrives as a gap.** The API follows a
 *   queue its own `BunJobs` creates at once, first start included. One
 *   another process creates is found by its next discovery pass
 *   (`discoveryInterval`, 2 s by default), after that worker's first start
 *   was published unheard, so `workers` subscribers get one `gap` with reason
 *   `queue-discovered`, shown as `gap: queue-discovered`; the queue's later
 *   events arrive. The sixth host, `cross`, runs over a file driver so that
 *   a child process (`helpers/remote-worker.ts`) can share it.
 * - **`types` in the URL takes bare or prefixed names.** `queue.completed`
 *   and `runner.failed` name their family; the console rewrites the URL with
 *   the bare name (`completed`). A name that is no event type, or one the
 *   channel does not carry, is ignored and named in
 *   `data-testid="events-types-ignored"`, and stays in the URL so the note
 *   survives a reload. With nothing valid left, every type shows, and the
 *   note ends "Showing every type."
 * - **The badge is `data-testid="live-status"`**, with `data-state` one of
 *   `off`, `connecting`, `live`, `reconnecting` or `refused`, and its text
 *   `Live`, `Connecting…`, `Reconnecting…` or `Polling 5s` (`Live off` on a
 *   docs-only UI). On the memory
 *   driver the events are `local`, so every host's badge also says
 *   `· events: local` and is a warning.
 * - **The Events console is `data-testid="events-screen"`**, its rows
 *   `event-row` with `data-type` the event's type (`gap` for a gap row). Its
 *   channel and type filter are the URL's `channel` and `types`.
 * - **Wait on conditions, never on time.** The page-side helpers poll the DOM
 *   until what they want is there, and the host-side waits poll the API or
 *   what `authorize` was asked.
 */
import type { JobsApiAuthorize } from "@kingsleyweb/bun-jobs";
import type { UiSections } from "@kingsleyweb/bun-jobs-ui";
import type { RemoteProcess } from "./helpers/remote-process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
import {
  button,
  chromeOrSkip,
  openView,
  textOf,
  waitForSelector,
} from "../shared/browser";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { startRemoteWorker } from "./helpers/remote-process";

// Decide whether to skip before printing anything: run-all.ts recognises a
// skip by the output *starting* with `skipped:`.
const chromePath = chromeOrSkip();

/** The queue the console watches. */
const QUEUE = "mail";
/** The socket's channel for it, as the console's `channel` parameter names it. */
const CHANNEL = `queue/${QUEUE}`;

/* --- the jobs: one driver, published events ----------------------- */

const driver = new MemoryDriver();
const jobs = new BunJobs({
  namespace: "examples-ui-live",
  driver,
  logger: noopLogger,
  // The socket carries only what producers publish.
  publishEvents: true,
});
// The same namespace from a context that does not publish: the `silent` host.
const silentJobs = new BunJobs({
  namespace: "examples-ui-live",
  driver,
  logger: noopLogger,
});

/** The namespace of the cross-process host, over a file driver. */
const CROSS_NAMESPACE = "examples-ui-live-cross";
/** Where that file driver keeps it: shared with the child process, removed on exit. */
const CROSS_ROOT = mkdtempSync(join(tmpdir(), "bun-jobs-ui-example-live-"));
process.once("exit", () => {
  rmSync(CROSS_ROOT, { recursive: true, force: true });
});
/**
 * The cross-process host's context. A second process (`remote-worker.ts`)
 * on the same directory is, to this context's notifier, another process: a
 * queue it creates is found only by the next discovery pass.
 */
const crossJobs = new BunJobs({
  namespace: CROSS_NAMESPACE,
  driver: { type: "file", root: CROSS_ROOT },
  logger: noopLogger,
  publishEvents: true,
});

/** One authorize call about the socket, and the URL that caused it. */
interface SocketCall {
  /** `events.connect` or `events.subscribe`. */
  action: string;
  /** The channel, for a subscribe. */
  channel?: string;
  /** The request's URL: the upgrade's, or a `/meta/permissions` preview's. */
  url: string;
}

/** A host: an API and the UI on an adapter of their own, listening. */
interface Host {
  /** Its origin, e.g. `http://localhost:41234`. */
  origin: string;
  /** The UI's base path. */
  uiBase: string;
  /** Every socket action `authorize` was asked about. */
  socketCalls: SocketCall[];
  /** Requests that asked to upgrade, whatever the answer. */
  upgrades: string[];
  /** Stops it. */
  close: () => Promise<void>;
}

/**
 * Serves an API over `context` and the UI on a fresh adapter on port 0. The
 * socket, when the API has one, is attached. `refuse` names socket actions
 * `authorize` says no to.
 */
async function serveHost(
  context: BunJobs,
  options: {
    /** `false` builds the API with no socket. */
    websocket?: false;
    /** Socket actions `authorize` refuses. */
    refuse?: readonly string[];
    /** The UI's sections; both on when absent. */
    sections?: Partial<UiSections>;
  } = {},
): Promise<Host> {
  const socketCalls: SocketCall[] = [];
  const upgrades: string[] = [];
  const authorize: JobsApiAuthorize = (req, ctx) => {
    if (ctx.transport === "ws") {
      socketCalls.push({
        action: ctx.action,
        channel: ctx.channel,
        url: req.originalUrl,
      });
    }
    return options.refuse?.includes(ctx.action)
      ? { allow: false, reason: "live events are not for this caller" }
      : true;
  };
  const api = createJobsApi({
    jobs: context,
    basePath: "/jobs-api",
    authorize,
    ...(options.websocket === false ? { websocket: false as const } : {}),
    logger: noopLogger,
  });
  const ui = jobsUi({
    api,
    logger: noopLogger,
    ...(options.sections ? { sections: options.sections } : {}),
  });
  const app = new BunHttpAdapter(0, { logger: noopLogger });
  // Ahead of everything, so it sees every upgrade whatever the answer.
  app.use((req, _res, next) => {
    if ((req.getHeader("upgrade") ?? "") !== "") {
      upgrades.push(req.originalUrl);
    }
    next();
  });
  app.use(api.basePath, api.router);
  api.websocket?.attach(app);
  app.use(ui.basePath, ui.router);
  await app.listen(0);
  const origin = app.url!.replace(/\/$/, "");
  // Build the bundle before the browser asks.
  await (await fetch(`${origin}${ui.basePath}`)).arrayBuffer();
  return {
    origin,
    uiBase: ui.basePath,
    socketCalls,
    upgrades,
    close: async () => {
      await app.close();
      await api.close();
    },
  };
}

const live = await serveHost(jobs);
const socketless = await serveHost(jobs, { websocket: false });
const refused = await serveHost(jobs, { refuse: ["events.connect"] });
const silent = await serveHost(silentJobs);
// Everything `live` has, but the UI shows documentation only.
const docsOnly = await serveHost(jobs, {
  sections: { manage: false, docs: true },
});
// Over a file driver, whose directory a second process shares: the host
// for a queue another process creates.
const cross = await serveHost(crossJobs);
const hosts = [live, socketless, refused, silent, docsOnly, cross];

/** The second process of the cross-process step, once started. */
let remote: RemoteProcess | undefined;

/** Winds everything down. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  await remote?.close();
  for (const host of hosts) {
    await host.close();
  }
  await silentJobs.close();
  await crossJobs.close();
  await jobs.close();
}

/** Adds a job with a known id and has a real worker complete it. */
async function completeJob(id: string): Promise<void> {
  const queue = jobs.queue(QUEUE);
  await queue.add("send-email", { id }, { jobId: id });
  const worker = jobs.worker(QUEUE, async () => "sent");
  void worker.run();
  await waitFor(
    `job ${id} to complete`,
    async () => (await queue.getJob(id))?.state === "completed",
  );
  await worker.close({ timeout: 1_000 });
}

/* --- the browser: skip, not fail, if Chrome will not start --------- */

/** What the page printed to its console, for a failure's diagnosis. */
const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, shutdown);

title("Live updates and the Events console, in Chrome");
show("Chrome", chromePath);
show("serving", `${live.origin}${live.uiBase}`);

/* --- page-side helpers --------------------------------------------- */

/** The live badge in a given state. */
function badgeIn(state: string): string {
  return `[data-testid="live-status"][data-state="${state}"]`;
}

/** Page-side: the badge's state, text and tooltip, as they are now. */
const BADGE = `(() => {
  const badge = document.querySelector('[data-testid="live-status"]');
  return badge && {
    state: badge.dataset.state,
    text: badge.textContent.trim(),
    title: badge.querySelector("[title]")?.getAttribute("title") ?? null,
  };
})()`;

/** What {@link BADGE} reads. */
interface Badge {
  /** `data-state`. */
  state: string;
  /** The visible text. */
  text: string;
  /** The tooltip. */
  title: string | null;
}

/** Page-side: every event row's `data-type`, newest first. */
const ROW_TYPES = `[...document.querySelectorAll('[data-testid="event-row"]')]
  .map((row) => row.dataset.type)`;

/** Page-side: the job link of every `completed` row, newest first. */
const COMPLETED_LINKS = `[...document.querySelectorAll('[data-testid="event-row"][data-type="completed"] .events-id a')]
  .map((link) => link.getAttribute("href"))`;

/** Page-side: resolves once a `completed` row links to `id`'s job, `false` after `ms`. */
function completedRowFor(id: string, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      const links = ${COMPLETED_LINKS};
      if (links.some((href) => href.endsWith(${JSON.stringify(`/jobs/${id}`)}))) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** Page-side: resolves once the held count is at least `count`; the text then, or `null`. */
function heldAtLeast(count: number, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      const text = document.querySelector('[data-testid="events-held"]')?.textContent.trim() ?? "";
      if (Number.parseInt(text, 10) >= ${count}) return resolve(text);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** How many times the page has subscribed `host` to `channel` over its socket. */
function subscribes(host: Host, channel: string): number {
  return host.socketCalls.filter(
    (call) =>
      call.action === "events.subscribe" &&
      call.channel === channel &&
      !call.url.includes("/meta/permissions"),
  ).length;
}

/** The upgrades a host received at its socket path. */
function socketUpgrades(host: Host): string[] {
  return host.upgrades.filter((url) => url.startsWith("/jobs-api/ws"));
}

/**
 * Page-side: resolves the value of `expression` once `accept(value)` holds,
 * or the last value after `ms`, so a failed check shows what the page had.
 */
function until(expression: string, accept: string, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      const value = ${expression};
      if ((${accept})(value) || Date.now() > deadline) return resolve(value);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** Page-side: the `types` URL parameter, as the page's location has it now. */
const TYPES_PARAM = `new URLSearchParams(location.search).get("types")`;

/** Page-side: the ignored-types note's text, or `null` while there is none. */
const IGNORED_NOTE = `document.querySelector('[data-testid="events-types-ignored"]')?.textContent.trim() ?? null`;

/** The Events console's actions (Pause, Resume, Clear). */
const LOG_ACTIONS = ".events-actions";

/** Page-side: the label of the Channel select's chosen scope, once it shows. */
const SCOPE_LABEL = textOf(".events-picker select option:checked");

/** Page-side: every scope the Channel select offers, by label. */
const SCOPE_LABELS = `[...document.querySelectorAll(".events-picker select option")]
  .map((option) => option.textContent.trim())`;

/**
 * Page-side: every worker event row as `[type, target, target href]`,
 * resolving once there are at least `count` (or what there is after `ms`).
 */
function workerRows(count: number, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const read = () => [...document.querySelectorAll('[data-testid="event-row"]')]
      .filter((row) => row.querySelector(".events-kind")?.textContent.trim().startsWith("worker"))
      .map((row) => {
        const link = row.querySelector(".events-target a");
        return [row.dataset.type, row.querySelector(".events-target").textContent.trim(), link?.getAttribute("href") ?? null];
      });
    const poll = () => {
      const rows = read();
      if (rows.length >= ${count} || Date.now() > deadline) return resolve(rows);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** A worker event row as the console shows it, its payload expanded. */
interface WorkerRow {
  /** `data-type`: the event's type (`state`, `config`, `control`). */
  type: string;
  /** The target cell's text: the worker's queue. */
  target: string;
  /** Where the target links. */
  href: string | null;
  /** The payload's fields as the page shows them, strings unquoted. */
  payload: Record<string, string>;
}

/**
 * Page-side: the worker event rows about worker `id`, newest first, as
 * {@link WorkerRow}s, resolving once there are at least `count` (or with what
 * there is after `ms`). Each row's payload starts collapsed, so this expands
 * it before reading it.
 */
function workerEvents(id: string, count: number, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const read = () => {
      let expanding = false;
      const rows = [...document.querySelectorAll('[data-testid="event-row"]')]
        .filter((row) => row.querySelector(".events-kind")?.textContent.trim().startsWith("worker"))
        .map((row) => {
          const toggle = row.querySelector('.events-payload .json-toggle[aria-expanded="false"]');
          if (toggle) {
            toggle.click();
            expanding = true;
          }
          const payload = Object.fromEntries([...row.querySelectorAll(".events-payload .json-children > .json-row")].map((item) => {
            const key = item.querySelector(".json-key")?.textContent ?? "";
            const text = item.textContent.slice(key.length).trim();
            return [key.replace(/:\\s*$/, ""), item.querySelector(".json-string") ? text.replace(/^"|"$/g, "") : text];
          }));
          const link = row.querySelector(".events-target a");
          return {
            type: row.dataset.type,
            target: row.querySelector(".events-target").textContent.trim(),
            href: link?.getAttribute("href") ?? null,
            payload,
          };
        });
      return expanding ? null : rows.filter((row) => row.payload.worker === ${JSON.stringify(id)});
    };
    const poll = () => {
      const rows = read();
      if ((rows && rows.length >= ${count}) || Date.now() > deadline) return resolve(rows ?? []);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** The fields `keys` of `row`'s payload that it has, for comparing (absent keys are left out). */
function payloadOf(
  row: WorkerRow | undefined,
  keys: string[],
): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) =>
      row?.payload[key] === undefined ? [] : [[key, row.payload[key]]],
    ),
  );
}

/** Page-side: the text of every gap row, newest first. */
const GAP_ROWS = `[...document.querySelectorAll('[data-testid="event-row"][data-type="gap"]')]
  .map((row) => row.textContent.replace(/\\s+/g, " ").trim())`;

/**
 * The watched worker's `reportInterval`, shorter than the 10 s default so the
 * wait stays short. Its record is written as it starts, so on a queue the API
 * already knows it is listed at once. A queue new to the API can take up to
 * `limits.queueCacheMs` (2 s by default) longer, and a loaded machine needs
 * headroom as well, so this is 3 s rather than 1.
 */
const WORKER_REPORT_MS = 3_000;

/** The queue whose worker must not show on mail's worker scope. */
const OTHER_QUEUE = "reports";

/** The queue the second process creates on the cross host, new to its API. */
const REMOTE_QUEUE = "remote-new";
/** The queue the cross host's own context creates after the page subscribed. */
const OWN_QUEUE = "own-new";
/** The API notifier's `discoveryInterval` (its default): how often it looks for queues another process created. */
const DISCOVERY_INTERVAL_MS = 2_000;
/** Headroom past a discovery pass for the gap to reach the page, on a loaded machine. */
const GAP_MARGIN_MS = 1_500;

try {
  /* ---------------------------------------------------------------- */
  step("A host with a socket: the badge goes live");

  await view.navigate(`${live.origin}${live.uiBase}/`);
  check(
    'the badge reaches data-state="live"',
    await view.evaluate<boolean>(waitForSelector(badgeIn("live"))),
    pageConsole,
  );
  const liveBadge = await view.evaluate<Badge>(BADGE);
  show("badge", liveBadge);
  checkEqual(
    "its text: Live, and a warning that the memory driver's events are local",
    liveBadge.text,
    "Live · events: local",
  );
  check(
    "its tooltip says live updates are on",
    liveBadge.title?.startsWith("Live updates are on") === true,
    liveBadge.title,
  );
  checkEqual(
    "one upgrade reached the socket path",
    socketUpgrades(live).length,
    1,
  );
  check(
    "and the nav has an Events entry",
    await view.evaluate<boolean>(
      waitForSelector(`nav a[href="${live.uiBase}/events"]`),
    ),
  );

  /* ---------------------------------------------------------------- */
  step("/events on mail's channel: a completed job appears");

  const before = subscribes(live, CHANNEL);
  await view.navigate(
    `${live.origin}${live.uiBase}/events?channel=${encodeURIComponent(CHANNEL)}`,
  );
  check(
    "the Events console renders (data-testid=events-screen)",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="events-screen"]'),
    ),
    pageConsole,
  );
  checkEqual(
    "watching the channel the URL names",
    await view.evaluate<string | null>(
      textOf('[data-testid="events-channel"]'),
    ),
    CHANNEL,
  );
  // Nothing is replayed to a fresh subscription, so an event sent before
  // the server has the subscription would never arrive. Wait for it.
  await waitFor(
    `the page to subscribe to ${CHANNEL}`,
    () => subscribes(live, CHANNEL) > before,
  );
  check(
    "and the badge is live again, on the new page's own socket",
    await view.evaluate<boolean>(waitForSelector(badgeIn("live"))),
  );

  await completeJob("live-1");
  check(
    "completing live-1 makes a completed event-row appear, linked to the job",
    await view.evaluate<boolean>(completedRowFor("live-1")),
    pageConsole,
  );
  const firstRows = await view.evaluate<string[]>(ROW_TYPES);
  show("rows, newest first", firstRows);
  checkEqual(
    "newest first: completed on top, added at the bottom",
    [firstRows[0], firstRows.at(-1)],
    ["completed", "added"],
  );
  checkEqual(
    "the job link is the job screen's path",
    (await view.evaluate<string[]>(COMPLETED_LINKS))[0],
    `${live.uiBase}/queues/${QUEUE}/jobs/live-1`,
  );

  /* ---------------------------------------------------------------- */
  step("Pause holds rows back, Resume shows them, Clear empties the log");

  check(
    "Pause is offered",
    await view.evaluate<boolean>(button(LOG_ACTIONS, "Pause", true)),
  );
  check(
    "and the held count shows",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="events-held"]'),
    ),
  );
  await completeJob("live-2");
  // The same job, the same events: as many as live-1 gave.
  const held = await view.evaluate<string | null>(
    heldAtLeast(firstRows.length),
  );
  checkEqual(
    `while paused, live-2's ${firstRows.length} events are held, not shown`,
    [held, (await view.evaluate<string[]>(COMPLETED_LINKS)).length],
    [`${firstRows.length} held`, 1],
  );
  check(
    "Resume is offered",
    await view.evaluate<boolean>(button(LOG_ACTIONS, "Resume", true)),
  );
  check(
    "and live-2's completed row is on top",
    await view.evaluate<boolean>(completedRowFor("live-2")),
  );
  checkEqual(
    "every row of both jobs, newest first",
    (await view.evaluate<string[]>(ROW_TYPES)).length,
    firstRows.length * 2,
  );
  check(
    "Clear is offered",
    await view.evaluate<boolean>(button(LOG_ACTIONS, "Clear", true)),
  );
  check(
    "and empties the log",
    await view.evaluate<boolean>(
      `new Promise((resolve) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          if (${ROW_TYPES}.length === 0) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(poll, 50);
        };
        poll();
      })`,
    ),
  );

  /* ---------------------------------------------------------------- */
  step('"Every worker (workers)": a worker\'s state events appear');

  const beforeWorkers = subscribes(live, "workers");
  await view.navigate(`${live.origin}${live.uiBase}/events?channel=workers`);
  checkEqual(
    "watching the workers channel",
    await view.evaluate<string | null>(
      textOf('[data-testid="events-channel"]'),
    ),
    "workers",
  );
  checkEqual(
    'the Channel select reads "Every worker (workers)"',
    await view.evaluate<string | null>(SCOPE_LABEL),
    "Every worker (workers)",
  );
  const scopes = await view.evaluate<string[]>(SCOPE_LABELS);
  show("scopes offered", scopes);
  check(
    `and offers "One queue's workers" too`,
    scopes.includes("One queue's workers"),
    scopes,
  );
  await waitFor(
    "the page to subscribe to workers",
    () => subscribes(live, "workers") > beforeWorkers,
  );

  // A worker announces its first start: once run() has settled what it is,
  // it publishes one `state` event with no `previous` — `running`, `paused`
  // when it was paused before run(), or `stopped` when a stop recorded
  // against its key holds it. Every later change carries `previous`.
  const mailWorker = jobs.worker(QUEUE, async () => "sent", {
    name: "watched",
    reportInterval: WORKER_REPORT_MS,
  });
  const startedAt = Date.now();
  void mailWorker.run();
  // Polled from the moment it runs, alongside the watch for its state row.
  const listed = (async () => {
    await waitFor(
      `${mailWorker.key} to be listed by GET /workers`,
      async () => {
        const response = await fetch(
          `${live.origin}/jobs-api/workers?queue=${QUEUE}`,
        );
        const { items } = (await response.json()) as {
          items: { key?: string }[];
        };
        return items.some((worker) => worker.key === mailWorker.key);
      },
    );
    return Date.now() - startedAt;
  })();
  const startRows = await view.evaluate<WorkerRow[]>(
    workerEvents(mailWorker.id, 1),
  );
  show("its rows", startRows);
  checkEqual(
    "its first run() gives one worker state row, its target the queue",
    startRows.map((row) => [row.type, row.target]),
    [["state", QUEUE]],
  );
  checkEqual(
    "the row's payload: its id and key, state running, and no previous",
    payloadOf(startRows[0], ["worker", "key", "state", "previous"]),
    { worker: mailWorker.id, key: mailWorker.key, state: "running" },
  );
  // A worker event's target is a queue, so its link should open the queue.
  checkEqual(
    "the row's target links to the queue, not to a runner",
    startRows[0]?.href,
    `${live.uiBase}/queues/${QUEUE}`,
  );
  const listedAfter = await listed;
  check(
    `GET /workers lists it too, within one reportInterval (${WORKER_REPORT_MS} ms)`,
    listedAfter <= WORKER_REPORT_MS,
    { listedAfter },
  );

  await mailWorker.pause();
  const pausedRows = await view.evaluate<WorkerRow[]>(
    workerEvents(mailWorker.id, 2),
  );
  show("its rows, newest first", pausedRows);
  checkEqual(
    "the pause that follows adds one state row, with previous: running",
    [
      pausedRows.map((row) => [row.type, row.target]),
      payloadOf(pausedRows[0], ["state", "previous"]),
    ],
    [
      [
        ["state", QUEUE],
        ["state", QUEUE],
      ],
      { state: "paused", previous: "running" },
    ],
  );
  mailWorker.resume();
  const resumedRows = await view.evaluate<WorkerRow[]>(
    workerEvents(mailWorker.id, 3),
  );
  checkEqual(
    "resuming it adds another, with previous: paused",
    [resumedRows.length, payloadOf(resumedRows[0], ["state", "previous"])],
    [3, { state: "running", previous: "paused" }],
  );

  // Paused before run(): the pause is folded into the first start.
  const pausedStart = jobs.worker(QUEUE, async () => "sent", {
    name: "paused-start",
  });
  await pausedStart.pause();
  void pausedStart.run();
  const pausedStartRows = await view.evaluate<WorkerRow[]>(
    workerEvents(pausedStart.id, 1),
  );
  show("a worker paused before run()", pausedStartRows);
  checkEqual(
    "a worker paused before run() announces one row: state paused, no previous",
    [
      pausedStartRows.length,
      payloadOf(pausedStartRows[0], ["state", "previous"]),
    ],
    [1, { state: "paused" }],
  );
  await pausedStart.close({ timeout: 1_000 });

  // A stop recorded against the key (`stopPersistence: "key"`) outlives the
  // process that took it: the next worker with that key starts parked.
  const heldOptions = { name: "held", stopPersistence: "key" } as const;
  const heldBefore = jobs.worker(QUEUE, async () => "sent", heldOptions);
  void heldBefore.run();
  await view.evaluate<WorkerRow[]>(workerEvents(heldBefore.id, 1));
  await jobs.workers.controller(QUEUE).stop({ id: heldBefore.id });
  await waitFor(
    `${heldBefore.key} to stop`,
    () => heldBefore.state === "stopped",
  );
  await heldBefore.close({ timeout: 1_000 });
  const heldAgain = jobs.worker(QUEUE, async () => "sent", heldOptions);
  void heldAgain.run();
  const heldRows = await view.evaluate<WorkerRow[]>(
    workerEvents(heldAgain.id, 1),
  );
  show(`the next ${heldAgain.key}, held by the key stop`, heldRows);
  checkEqual(
    'the next worker with that key announces one row: stopped, reason "stopped persistently", no previous',
    [
      heldRows.length,
      payloadOf(heldRows[0], ["key", "state", "reason", "previous"]),
    ],
    [
      1,
      { key: heldBefore.key, state: "stopped", reason: "stopped persistently" },
    ],
  );
  // Released, so nothing later on this queue inherits the stop.
  await jobs.workers.controller(QUEUE).start({ id: heldAgain.id });
  await heldAgain.close({ timeout: 1_000 });

  /* ---------------------------------------------------------------- */
  step(`"One queue's workers" (queue/${QUEUE}/workers): only mail's`);

  const queueWorkers = `queue/${QUEUE}/workers`;
  const beforeQueueWorkers = subscribes(live, queueWorkers);
  await view.navigate(
    `${live.origin}${live.uiBase}/events?channel=${encodeURIComponent(queueWorkers)}`,
  );
  checkEqual(
    `watching ${queueWorkers}`,
    await view.evaluate<string | null>(
      textOf('[data-testid="events-channel"]'),
    ),
    queueWorkers,
  );
  checkEqual(
    `the Channel select reads "One queue's workers", the Queue field ${QUEUE}`,
    [
      await view.evaluate<string | null>(SCOPE_LABEL),
      await view.evaluate<string | null>(
        until(
          `[...document.querySelectorAll(".events-picker select, .events-picker input")][1]?.value ?? null`,
          `(value) => value === ${JSON.stringify(QUEUE)}`,
        ),
      ),
    ],
    ["One queue's workers", QUEUE],
  );
  await waitFor(
    `the page to subscribe to ${queueWorkers}`,
    () => subscribes(live, queueWorkers) > beforeQueueWorkers,
  );
  // First a worker of another queue changes state, then mail's: once mail's
  // row is there, the other's would have been too, had it been carried.
  const otherWorker = jobs.worker(OTHER_QUEUE, async () => "done", {
    name: "unwatched",
  });
  void otherWorker.run();
  await otherWorker.pause();
  await mailWorker.pause();
  const queueRows = await view.evaluate<[string, string, string | null][]>(
    workerRows(1),
  );
  show("worker rows", queueRows);
  check(
    "pausing mail's worker again shows its state row",
    queueRows.some(([type, target]) => type === "state" && target === QUEUE),
    queueRows,
  );
  checkEqual(
    `and no row is about ${OTHER_QUEUE}'s worker`,
    queueRows.filter(([, target]) => target !== QUEUE),
    [],
  );
  await otherWorker.close({ timeout: 1_000 });
  await mailWorker.close({ timeout: 1_000 });

  /* ---------------------------------------------------------------- */
  step(
    "A queue another process creates: gap: queue-discovered, then its events",
  );

  const beforeCross = subscribes(cross, "workers");
  await view.navigate(`${cross.origin}${cross.uiBase}/events?channel=workers`);
  check(
    "the cross host's Events console renders, on the workers channel",
    (await view.evaluate<boolean>(
      waitForSelector('[data-testid="events-screen"]'),
    )) &&
      (await view.evaluate<string | null>(
        textOf('[data-testid="events-channel"]'),
      )) === "workers",
    pageConsole,
  );
  await waitFor(
    "the page to subscribe to workers on the cross host",
    () => subscribes(cross, "workers") > beforeCross,
  );
  check(
    "and its badge is live (a file driver's events are not local)",
    await view.evaluate<boolean>(waitForSelector(badgeIn("live"))),
    await view.evaluate<Badge>(BADGE),
  );
  // A queue another process creates is found by the API's next discovery
  // pass. The worker's first start is published before that, unheard, so
  // the `workers` channel sends a gap instead.
  remote = await startRemoteWorker({
    root: CROSS_ROOT,
    namespace: CROSS_NAMESPACE,
    queue: REMOTE_QUEUE,
    service: "elsewhere",
  });
  const gapRows = await view.evaluate<string[]>(
    until(
      GAP_ROWS,
      "(rows) => rows.length > 0",
      DISCOVERY_INTERVAL_MS + GAP_MARGIN_MS,
    ),
  );
  const gapAfter = Date.now() - remote.readyAt;
  show(
    `gap rows, ${gapAfter} ms after the other process's worker started`,
    gapRows,
  );
  checkEqual(
    // No range in the wording: this gap carries `fromSeq: 0` and `toSeq: 0`,
    // the connection having been sent no sequenced event yet, and a row with
    // nothing to name leaves the range out. A gap with a real range still
    // reads "events 10–42 may be missing on all".
    "one gap row, about the workers channel, with no range to name",
    gapRows.map((text) =>
      /^.*gap: (\S+) events may be missing on (\S+)$/.exec(text)?.slice(1),
    ),
    [["queue-discovered", "workers"]],
  );
  check(
    `within discoveryInterval (${DISCOVERY_INTERVAL_MS} ms) plus ${GAP_MARGIN_MS} ms`,
    gapAfter <= DISCOVERY_INTERVAL_MS + GAP_MARGIN_MS,
    { gapAfter },
  );
  await remote.send("pause");
  const remoteRows = await view.evaluate<WorkerRow[]>(
    workerEvents(remote.id, 1),
  );
  show(`${REMOTE_QUEUE}'s worker rows`, remoteRows);
  // Its first start came before discovery, so it is normally missing here;
  // only the pause, which came after, is asserted.
  const remoteNewest = remoteRows[0];
  checkEqual(
    "from then on its events arrive: pausing it shows a state row, previous running, target its queue",
    [
      [remoteNewest?.type, remoteNewest?.target, remoteNewest?.href],
      payloadOf(remoteNewest, ["state", "previous"]),
    ],
    [
      ["state", REMOTE_QUEUE, `${cross.uiBase}/queues/${REMOTE_QUEUE}`],
      { state: "paused", previous: "running" },
    ],
  );

  // A queue the API's own BunJobs creates is followed at once: its first
  // start arrives, and no discovery pass later reports it as a gap.
  const ownWorker = crossJobs.worker(OWN_QUEUE, async () => "done", {
    reportInterval: WORKER_REPORT_MS,
  });
  const ownStartedAt = Date.now();
  void ownWorker.run();
  const ownRows = await view.evaluate<WorkerRow[]>(
    workerEvents(ownWorker.id, 1),
  );
  checkEqual(
    `a new queue the API's own process creates (${OWN_QUEUE}): its first start arrives, no previous`,
    [
      ownRows.map((row) => [row.type, row.target]),
      payloadOf(ownRows[0], ["state", "previous"]),
    ],
    [[["state", OWN_QUEUE]], { state: "running" }],
  );
  // Past the next discovery pass, with a margin: had it counted as
  // discovered, its gap would be here by now.
  const quietGaps = await view.evaluate<string[]>(
    until(
      GAP_ROWS,
      "(rows) => rows.length > 1",
      ownStartedAt + DISCOVERY_INTERVAL_MS + GAP_MARGIN_MS - Date.now(),
    ),
  );
  checkEqual(
    `and no second gap row, ${DISCOVERY_INTERVAL_MS + GAP_MARGIN_MS} ms on`,
    quietGaps.length,
    1,
  );
  await ownWorker.close({ timeout: 1_000 });
  await remote.close();

  /* ---------------------------------------------------------------- */
  step("types= in the URL: prefixed names written bare, unknown ones named");

  const eventsUrl = (types: string) =>
    `${live.origin}${live.uiBase}/events?channel=${encodeURIComponent(CHANNEL)}&types=${encodeURIComponent(types)}`;

  await view.navigate(eventsUrl("queue.completed,bogus"));
  check(
    "the Events console renders",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="events-screen"]'),
    ),
    pageConsole,
  );
  checkEqual(
    "types=queue.completed,bogus is rewritten to completed,bogus: the prefix goes, bogus stays",
    await view.evaluate<string | null>(
      until(TYPES_PARAM, `(value) => value === "completed,bogus"`),
    ),
    "completed,bogus",
  );
  const mixedNote = await view.evaluate<string | null>(
    until(IGNORED_NOTE, `(value) => value !== null`),
  );
  show("events-types-ignored", mixedNote);
  check(
    "the events-types-ignored note names bogus as no event type",
    mixedNote?.includes("bogus (not an event type)") === true,
    mixedNote,
  );
  check(
    'completed is still a filter, so the note does not say "Showing every type."',
    mixedNote !== null && !mixedNote.endsWith("Showing every type."),
    mixedNote,
  );

  await view.navigate(eventsUrl("bogus,runner.failed"));
  const allNote = await view.evaluate<string | null>(
    until(
      IGNORED_NOTE,
      `(value) => value !== null && value.includes("runner.failed")`,
    ),
  );
  show("events-types-ignored", allNote);
  check(
    `runner.failed is a type ${CHANNEL} does not carry`,
    allNote?.includes(`runner.failed (${CHANNEL} does not carry it)`) === true,
    allNote,
  );
  check(
    'with nothing valid left, the note ends "Showing every type."',
    allNote?.endsWith("Showing every type.") === true,
    allNote,
  );
  checkEqual(
    "and both names stay in the URL, so the note survives a reload",
    await view.evaluate<string | null>(TYPES_PARAM),
    "bogus,runner.failed",
  );

  /* ---------------------------------------------------------------- */
  step("websocket: false — no socket, so polling");

  await view.navigate(`${socketless.origin}${socketless.uiBase}/`);
  check(
    'the badge is data-state="off"',
    await view.evaluate<boolean>(waitForSelector(badgeIn("off"))),
    pageConsole,
  );
  const offBadge = await view.evaluate<Badge>(BADGE);
  show("badge", offBadge);
  check(
    'its text says "Polling 5s"',
    offBadge.text.startsWith("Polling 5s"),
    offBadge.text,
  );
  check(
    "its tooltip: the API has no live-events socket",
    offBadge.title?.includes("The API has no live-events socket") === true,
    offBadge.title,
  );
  check(
    "no Events entry in the nav (the Queues entry is there)",
    (await view.evaluate<boolean>(
      waitForSelector(`nav a[href="${socketless.uiBase}/queues"]`),
    )) &&
      !(await view.evaluate<boolean>(
        waitForSelector(`nav a[href="${socketless.uiBase}/events"]`, 0),
      )),
  );

  /* ---------------------------------------------------------------- */
  step("events.connect refused — the badge is off, and says why");

  await view.navigate(`${refused.origin}${refused.uiBase}/`);
  check(
    'the badge is data-state="off"',
    await view.evaluate<boolean>(waitForSelector(badgeIn("off"))),
    pageConsole,
  );
  const refusedBadge = await view.evaluate<Badge>(BADGE);
  show("badge", refusedBadge);
  check(
    'its text says "Polling 5s"',
    refusedBadge.text.startsWith("Polling 5s"),
    refusedBadge.text,
  );
  check(
    "its tooltip: you may not connect to live events (events.connect)",
    refusedBadge.title?.includes(
      "You may not connect to live events (events.connect)",
    ) === true,
    refusedBadge.title,
  );
  check(
    "no Events entry in the nav",
    (await view.evaluate<boolean>(
      waitForSelector(`nav a[href="${refused.uiBase}/queues"]`),
    )) &&
      !(await view.evaluate<boolean>(
        waitForSelector(`nav a[href="${refused.uiBase}/events"]`, 0),
      )),
  );

  /* ---------------------------------------------------------------- */
  step("Nothing publishes, and events are local — nothing to connect for");

  await view.navigate(`${silent.origin}${silent.uiBase}/`);
  check(
    'the badge is data-state="off"',
    await view.evaluate<boolean>(waitForSelector(badgeIn("off"))),
    pageConsole,
  );
  const silentBadge = await view.evaluate<Badge>(BADGE);
  show("badge", silentBadge);
  checkEqual(
    "its text names both warnings",
    silentBadge.text,
    "Polling 5s · events: local · publishing: no",
  );
  check(
    "its tooltip: nothing publishes events to this API",
    silentBadge.title?.includes("Nothing publishes events to this API") ===
      true,
    silentBadge.title,
  );

  /* ---------------------------------------------------------------- */
  step("A docs-only UI — no live screen, so no socket");

  await view.navigate(`${docsOnly.origin}${docsOnly.uiBase}/`);
  check(
    "the app is ready (data-testid=app-ready)",
    await view.evaluate<boolean>(waitForSelector('[data-testid="app-ready"]')),
    pageConsole,
  );
  check(
    'the badge still renders, data-state="off"',
    await view.evaluate<boolean>(waitForSelector(badgeIn("off"))),
    pageConsole,
  );
  const docsBadge = await view.evaluate<Badge>(BADGE);
  show("badge", docsBadge);
  // Not "Polling 5s": a docs-only UI neither listens nor polls, so the
  // badge names neither, and carries no events warning either.
  checkEqual('its text is "Live off"', docsBadge.text, "Live off");
  check(
    "its tooltip: Live updates are off: this UI shows documentation only",
    docsBadge.title?.includes(
      "Live updates are off: this UI shows documentation only",
    ) === true,
    docsBadge.title,
  );
  check(
    "no Events entry in the nav",
    !(await view.evaluate<boolean>(
      waitForSelector(`nav a[href="${docsOnly.uiBase}/events"]`, 0),
    )),
  );

  checkEqual(
    "none of the four off hosts was ever asked to upgrade, though docsOnly's API has a socket",
    [socketless, refused, silent, docsOnly].map((host) => socketUpgrades(host)),
    [[], [], [], []],
  );
} catch (error) {
  console.log(`page console:\n${pageConsole.join("\n")}`);
  throw error;
} finally {
  await shutdown(view);
}

summary();
