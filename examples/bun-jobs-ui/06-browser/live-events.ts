/**
 * Live updates in a real browser: the header's live badge, the Events
 * console tailing a queue as a real worker completes a job, its `types`
 * filter read from the URL, and the badge staying off, with its reason, on
 * hosts that cannot, may not, or need not connect.
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
 * Five hosts over one set of jobs, each an API and the UI on its own port:
 *
 * | Host        | API                                     | Badge                        |
 * |-------------|-----------------------------------------|------------------------------|
 * | `live`      | a socket, attached; `authorize` says yes | `live`                      |
 * | `socketless`| `websocket: false`                      | `off`: no socket             |
 * | `refused`   | a socket, but `events.connect` refused  | `off`: may not connect       |
 * | `silent`    | a socket, but nothing publishes events  | `off`: nothing publishes     |
 * | `docsOnly`  | as `live`, but the UI is `sections: { manage: false }` | `off`, "Live off": documentation only |
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
 *   `worker`, `target` the queue). A worker publishes a `state` event only
 *   on a change (a pause, a resume, a stop, a restart, a config change),
 *   never on its first `run()`: a new worker appears through its heartbeat
 *   record in `GET /workers` within one `reportInterval`. The rows here come
 *   from a real worker pausing and resuming, and a worker of another queue
 *   never shows on one queue's scope.
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
const hosts = [live, socketless, refused, silent, docsOnly];

/** Winds everything down. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  for (const host of hosts) {
    await host.close();
  }
  await silentJobs.close();
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

/**
 * The watched worker's `reportInterval`, shorter than the 10 s default so the
 * wait stays short. Its record is written as it starts, so on a queue the API
 * already knows it is listed at once. A queue new to the API can take up to
 * `limits.queueCacheMs` (2 s by default) longer, and a loaded machine needs
 * headroom as well, so this is 3 s rather than 1.
 */
const WORKER_REPORT_MS = 3_000;

/** How long to watch for a state row that must not come, well under the run's budget. */
const NO_EVENT_WINDOW_MS = 1_500;

/** The queue whose worker must not show on mail's worker scope. */
const OTHER_QUEUE = "reports";

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

  // A worker publishes a `state` event only on a change (paused, resumed,
  // stopping/stopped, started again, restarting, a config change). Its first
  // run() is not one: a new worker shows up through its heartbeat record in
  // GET /workers instead, within one reportInterval.
  const mailWorker = jobs.worker(QUEUE, async () => "sent", {
    name: "watched",
    reportInterval: WORKER_REPORT_MS,
  });
  const startedAt = Date.now();
  void mailWorker.run();
  // Polled from the moment it runs, alongside the watch for a state row.
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
  checkEqual(
    `its first run() adds no state row (watched for ${NO_EVENT_WINDOW_MS} ms)`,
    await view.evaluate<[string, string, string | null][]>(
      workerRows(1, NO_EVENT_WINDOW_MS),
    ),
    [],
  );
  const listedAfter = await listed;
  check(
    `but GET /workers lists it within one reportInterval (${WORKER_REPORT_MS} ms)`,
    listedAfter <= WORKER_REPORT_MS,
    { listedAfter },
  );
  await mailWorker.pause();
  const pausedRows = await view.evaluate<[string, string, string | null][]>(
    workerRows(1),
  );
  show("worker rows", pausedRows);
  checkEqual(
    "the pause that follows does: one worker state row, its target the queue",
    pausedRows.map(([type, target]) => [type, target]),
    [["state", QUEUE]],
  );
  await mailWorker.resume();
  checkEqual(
    "resuming it adds another",
    (await view.evaluate<[string, string, string | null][]>(workerRows(2))).map(
      ([type, target]) => [type, target],
    ),
    [
      ["state", QUEUE],
      ["state", QUEUE],
    ],
  );
  // A worker event's target is a queue, so its link should open the queue.
  checkEqual(
    "the row's target links to the queue, not to a runner",
    pausedRows[0]?.[2],
    `${live.uiBase}/queues/${QUEUE}`,
  );

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
