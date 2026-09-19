/**
 * The UI's accessibility features in a real browser, driven by the keyboard
 * where a user would use it: the `/` and `?` shortcuts, the skip link, the
 * screens' headings, the Events console's Pause button, the live-status
 * announcer, reduced motion, and the error boundary each routed screen sits
 * in.
 *
 * ```bash
 * bun 06-browser/accessibility.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/accessibility.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/accessibility.ts   # skip on purpose
 * ```
 *
 * Like the other browser examples it drives headless Chrome through
 * `Bun.WebView` and **skips** (prints `skipped:` and exits 0) when there is
 * no `Bun.WebView`, no Chrome, or Chrome will not start.
 *
 * What it shows:
 *
 * - **`/` focuses the screen's search box** on the Overview, Queues, a
 *   queue's jobs, Runners and both API references. The box is the first one
 *   in `<main>` marked `data-shortcut="search"`, and it carries
 *   `aria-keyshortcuts="/"`, so a screen reader announces the shortcut. The
 *   key is taken (`preventDefault`), so the box stays empty.
 * - **Nothing fires while you type, with a modifier, or under a dialog.**
 *   `/` in a text field types a `/`; Ctrl+/ and Alt+/ are left to the
 *   browser; with a dialog open the page behind is inert and `/` does
 *   nothing.
 * - **`?` lists the shortcuts** in a dialog (`data-testid="shortcut-list"`).
 *   Escape closes it and hands focus back to whatever had it.
 * - **The skip link is the first Tab stop**, and Enter on it focuses
 *   `<main id="main">` directly, without writing `#main` into the app's URL.
 * - **An empty or error state that *is* the screen is its `h1`**: "Job not
 *   found", "Job hidden" and "Runner not found", the page's only `h1`.
 * - **The Events console's Pause has no `aria-pressed`.** Its label says what
 *   a press does (Pause, then Resume), which a pressed state would
 *   contradict.
 * - **The live badge speaks on a change of state only**, through a polite
 *   live region beside it (`data-testid="live-status-announcer"`): "Live
 *   updates: Live · events: local" once connected, "Live updates:
 *   Reconnecting… · events: local" when the host goes away.
 * - **Reduced motion**, emulated through the DevTools protocol: transitions
 *   collapse to 0.01ms, and the spinner keeps turning, three times slower.
 * - **A screen that crashes while rendering** shows `data-testid=
 *   "screen-error"` ("This screen failed to show") in its place, while the
 *   header, nav and badge keep working, and offers "Reload this screen".
 *   The crash is made from outside: a host middleware answers one job's
 *   read with a `name` that is an object, which React cannot render. That
 *   button remounts the screen over the same query cache, so a crash caused
 *   by a cached answer comes straight back; a page reload, with the host
 *   answering truthfully, draws the job.
 *
 * Keys are sent with `view.press()`, a trusted `keydown` with the key's
 * `key` (`"/"`, `"?"`, `"Tab"`, `"Enter"`, `"Escape"`), exactly what the
 * app's listener reads. A page-side recorder proves each modifier chord
 * really arrived, so "nothing happened" is never just "nothing was sent".
 * Every wait is on a condition, never on time.
 */
import type { JobsApiAuthorize } from "@kingsleyweb/bun-jobs";
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
import { show, step, title } from "../shared/console";

// Decide whether to skip before printing anything: run-all.ts recognises a
// skip by the output *starting* with `skipped:`.
const chromePath = chromeOrSkip();

/** A queue with a waiting job, so every queue screen has something to show. */
const QUEUE = "mail";
/** Its job. */
const JOB_ID = "welcome-ada";
/** A job whose read the host garbles until told to stop. */
const GARBLED_ID = "garbled";
/** A queue whose jobs this caller may list but not read. */
const VAULT = "vault";
/** Its job. */
const VAULT_JOB = "payslip-ada";
/** A runner, so the Runners screen has a list (and its search box). */
const RUNNER = "nightly-report";

/* --- the server: a real API with its socket attached, and the UI ---- */

const jobs = new BunJobs({
  namespace: "examples-ui-a11y",
  driver: new MemoryDriver(),
  logger: noopLogger,
  // The live badge goes live only when producers publish.
  publishEvents: true,
});

/** Everything is allowed but reading vault's jobs: that shows "Job hidden". */
const authorize: JobsApiAuthorize = (_req, ctx) =>
  ctx.action === "jobs.read" && ctx.queue === VAULT
    ? { allow: false, reason: `jobs of ${VAULT}` }
    : true;

const api = createJobsApi({
  jobs,
  basePath: "/jobs-api",
  authorize,
  logger: noopLogger,
});
const ui = jobsUi({ api, logger: noopLogger });
const app = new BunHttpAdapter(0, { logger: noopLogger });

/** While `true`, the host answers {@link GARBLED_ID}'s read with a body the screen cannot draw. */
let garble = true;
/** How many garbled answers the host sent. */
let garbledAnswers = 0;

// Ahead of the API: a job whose `name` is an object. The client does not
// validate shapes, so the job screen renders it, and React throws
// ("Objects are not valid as a React child"): a render crash, which is
// exactly what the per-screen error boundary is for.
app.use((req, res, next) => {
  if (
    garble &&
    req.method === "GET" &&
    req.path === `${api.basePath}/queues/${QUEUE}/jobs/${GARBLED_ID}`
  ) {
    garbledAnswers++;
    res.status(200).json({
      id: GARBLED_ID,
      queue: QUEUE,
      name: { not: "a string" },
      state: "waiting",
    });
    return;
  }
  next();
});
app.use(api.basePath, api.router);
api.websocket?.attach(app);
app.use(ui.basePath, ui.router);
await app.listen(0);
const origin = app.url!.replace(/\/$/, "");
const base = `${origin}${ui.basePath}`;

const mail = jobs.queue(QUEUE);
await mail.add("send-email", { to: "ada@example.com" }, { jobId: JOB_ID });
await mail.add("send-email", { to: "ops@example.com" }, { jobId: GARBLED_ID });
await jobs.queue(VAULT).add("payslip", { to: "ada" }, { jobId: VAULT_JOB });
await jobs
  .runner({
    id: RUNNER,
    file: new URL("../shared/handlers/hold.ts", import.meta.url),
    executionMode: "in-process",
    waitToExit: false,
  })
  .start();

/** Whether the host has been stopped already (the last step stops it). */
let hostClosed = false;

/** Stops the host; safe to call more than once. */
async function closeHost(): Promise<void> {
  if (!hostClosed) {
    hostClosed = true;
    await app.close();
  }
}

/** Winds everything down. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  await closeHost();
  await api.close();
  await jobs.close();
}

// Build the bundle before the browser asks, so the first page load is not
// the in-memory build.
await (await fetch(base)).arrayBuffer();

/* --- the browser: skip, not fail, if Chrome will not start --------- */

/** What the page printed to its console, for a failure's diagnosis. */
const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, shutdown);

title("Accessibility: shortcuts, skip link, headings and announcements");
show("Chrome", chromePath);
show("serving", `${base}/`);

/* --- page-side helpers --------------------------------------------- */

/** The search box a `/` focuses. */
const SEARCH = 'main [data-shortcut="search"]';
/** The open dialog. */
const DIALOG = "dialog[open]";

/**
 * Page-side: resolves the value of `expression` once `accept(value)` holds,
 * or the last value after `ms`, so a failed check shows what the page had.
 */
function until(expression: string, accept: string, ms = 10_000): string {
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

/** Page-side: resolves `true` once nothing matches `selector`, `false` after `ms`. */
function gone(selector: string, ms = 10_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      if (!document.querySelector(${JSON.stringify(selector)})) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** What {@link FOCUS} reads about the focused element. */
interface Focused {
  /** Its tag, e.g. `INPUT`. */
  tag: string;
  /** Its `id`. */
  id: string;
  /** Whether it is the screen's search box (`data-shortcut="search"`). */
  search: boolean;
  /** Its `aria-keyshortcuts`, or `null`. */
  keys: string | null;
  /** Its value, for a field. */
  value: string | null;
  /** Whether it sits inside an open dialog. */
  inDialog: boolean;
}

/** Page-side: the focused element, as {@link Focused}. */
const FOCUS = `(() => {
  const element = document.activeElement;
  return {
    tag: element.tagName,
    id: element.id,
    search: element.matches('[data-shortcut="search"]'),
    keys: element.getAttribute("aria-keyshortcuts"),
    value: "value" in element ? element.value : null,
    inDialog: element.closest("dialog[open]") !== null,
  };
})()`;

/**
 * Page-side: starts recording every `keydown` the document sees, with its
 * modifiers, into `window.__keys`. Capturing, so it sees each one before
 * the app's own listener.
 */
const RECORD_KEYS = `(() => {
  window.__keys = [];
  document.addEventListener("keydown", (event) => {
    window.__keys.push({ key: event.key, ctrl: event.ctrlKey, alt: event.altKey });
  }, { capture: true });
  return true;
})()`;

/** One `keydown` {@link RECORD_KEYS} saw. */
interface KeyRecord {
  /** `KeyboardEvent.key`. */
  key: string;
  /** Whether Ctrl was held. */
  ctrl: boolean;
  /** Whether Alt was held. */
  alt: boolean;
}

/** Opens `path` under the UI and waits for the app to be ready. */
async function open(path: string): Promise<boolean> {
  await view.navigate(`${base}${path}`);
  return view.evaluate<boolean>(waitForSelector('[data-testid="app-ready"]'));
}

/** Page-side: every `h1`'s text, in document order. */
const H1S = `[...document.querySelectorAll("h1")].map((heading) => heading.textContent.trim())`;

try {
  /* ---------------------------------------------------------------- */
  step("/ focuses the screen's search box, on every screen that has one");

  const screens: [string, string][] = [
    ["Overview", "/"],
    ["Queues", "/queues"],
    [`${QUEUE}'s jobs`, `/queues/${QUEUE}`],
    ["Runners", "/runners"],
    ["HTTP API reference", "/docs/http"],
    ["WebSocket API reference", "/docs/ws"],
  ];
  for (const [name, path] of screens) {
    await open(path);
    const ready = await view.evaluate<boolean>(waitForSelector(SEARCH));
    await view.press("/");
    const focused = await view.evaluate<Focused>(
      until(FOCUS, "(value) => value.search"),
    );
    check(
      `${name} (${path}): / focuses its search box, which has aria-keyshortcuts="/" and stays empty`,
      ready && focused.search && focused.keys === "/" && focused.value === "",
      { ready, focused, pageConsole },
    );
  }

  /* ---------------------------------------------------------------- */
  step("/ while typing, with a modifier, or under a dialog: nothing");

  await open("/docs/http/getQueue");
  const field = await view.evaluate<boolean>(
    `new Promise((resolve) => {
      const deadline = Date.now() + 10000;
      const poll = () => {
        const input = document.querySelector('[data-testid="tryit"] input');
        if (input) {
          input.focus();
          return resolve(document.activeElement === input);
        }
        if (Date.now() > deadline) return resolve(false);
        setTimeout(poll, 50);
      };
      poll();
    })`,
  );
  check("getQueue's try-it has a text field, now focused", field, pageConsole);
  await view.press("/");
  const typed = await view.evaluate<Focused>(FOCUS);
  check(
    "/ in it types a / and focus stays in the field, though the sidebar has a search box",
    typed.value === "/" && !typed.search && typed.tag === "INPUT",
    typed,
  );

  await open("/queues");
  await view.evaluate<boolean>(waitForSelector(SEARCH));
  await view.evaluate<boolean>(RECORD_KEYS);
  await view.press("/", { modifiers: ["Control"] });
  await view.press("/", { modifiers: ["Alt"] });
  // Both chords must have reached the page, or "nothing happened" proves
  // nothing. Held: a keydown for the modifier itself may come first.
  const chords = await view.evaluate<KeyRecord[]>(
    until(
      `window.__keys.filter((record) => record.key === "/")`,
      "(value) => value.length >= 2",
    ),
  );
  checkEqual(
    "Ctrl+/ and Alt+/ both reached the page, with their modifier",
    chords.map((record) => [record.ctrl, record.alt]),
    [
      [true, false],
      [false, true],
    ],
  );
  check(
    "and neither focused the search box",
    !(await view.evaluate<Focused>(FOCUS)).search,
  );

  /* ---------------------------------------------------------------- */
  step("? lists the shortcuts; Escape closes the list and hands focus back");

  // Start from a nav link: not a field, so ? is a shortcut, and focus has
  // somewhere to come back to.
  const queuesLink = `nav a[href="${ui.basePath}/queues"]`;
  check(
    "a nav link has focus",
    await view.evaluate<boolean>(
      `(() => { const link = document.querySelector(${JSON.stringify(queuesLink)}); link.focus(); return document.activeElement === link; })()`,
    ),
  );
  await view.press("?");
  check(
    "? opens a dialog holding data-testid=shortcut-list",
    await view.evaluate<boolean>(
      waitForSelector(`${DIALOG} [data-testid="shortcut-list"]`),
    ),
    pageConsole,
  );
  const listed = await view.evaluate<string[]>(
    `[...document.querySelectorAll('[data-testid="shortcut-list"] dd')].map((entry) => entry.textContent.trim())`,
  );
  show("listed", listed);
  check(
    "it lists / and ?",
    listed.includes("Focus the screen's search box") &&
      listed.includes("Show these shortcuts"),
    listed,
  );
  await view.press("/");
  const underDialog = await view.evaluate<Focused>(FOCUS);
  check(
    "/ with the dialog open does nothing: focus stays in the dialog, the search box untouched",
    underDialog.inDialog &&
      !underDialog.search &&
      (await view.evaluate<string>(
        `document.querySelector(${JSON.stringify(SEARCH)}).value`,
      )) === "",
    underDialog,
  );
  check(
    "and the dialog is still open",
    await view.evaluate<boolean>(waitForSelector(DIALOG, 0)),
  );
  await view.press("Escape");
  check(
    "Escape closes it",
    await view.evaluate<boolean>(gone(DIALOG)),
    pageConsole,
  );
  check(
    "and focus is back on the nav link",
    await view.evaluate<boolean>(
      until(
        `document.activeElement.matches(${JSON.stringify(queuesLink)})`,
        "(value) => value",
      ),
    ),
  );

  /* ---------------------------------------------------------------- */
  step("The skip link: the first Tab stop, and Enter focuses <main>");

  await open("/");
  await view.press("Tab");
  checkEqual(
    'Tab lands on "Skip to content"',
    await view.evaluate<string | null>(
      until(
        `document.activeElement.matches("a.skip-link") ? document.activeElement.textContent.trim() : null`,
        "(value) => value !== null",
      ),
    ),
    "Skip to content",
  );
  await view.press("Enter");
  checkEqual(
    "Enter focuses <main id=main>",
    await view.evaluate<string>(
      until(
        `document.activeElement.tagName + "#" + document.activeElement.id`,
        `(value) => value === "MAIN#main"`,
      ),
    ),
    "MAIN#main",
  );
  checkEqual(
    "and #main is not written into the URL",
    await view.evaluate<string>("location.hash"),
    "",
  );

  /* ---------------------------------------------------------------- */
  step("Not-found and hidden screens: their title is the page's h1");

  const headings: [string, string, string, string][] = [
    [
      "a job that does not exist",
      `/queues/${QUEUE}/jobs/missing`,
      "job-not-found",
      "Job not found",
    ],
    [
      `a job of ${VAULT}, whose jobs.read is refused`,
      `/queues/${VAULT}/jobs/${VAULT_JOB}`,
      "job-hidden",
      "Job hidden",
    ],
    [
      "a runner that does not exist",
      "/runners/missing",
      "runner-not-found",
      "Runner not found",
    ],
  ];
  for (const [what, path, testid, heading] of headings) {
    await open(path);
    const shown = await view.evaluate<boolean>(
      waitForSelector(`[data-testid="${testid}"] h1`),
    );
    checkEqual(
      `${what}: data-testid=${testid}, and "${heading}" is the only h1`,
      [shown, await view.evaluate<string[]>(H1S)],
      [true, [heading]],
    );
  }

  /* ---------------------------------------------------------------- */
  step("The Events console's Pause: a label that changes, no aria-pressed");

  await open(`/events?channel=${encodeURIComponent(`queue/${QUEUE}`)}`);
  const pressedOf = (label: string) =>
    view.evaluate<string | null | false>(
      `(() => {
        const found = [...document.querySelectorAll(".events-actions button")]
          .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)});
        return found ? found.getAttribute("aria-pressed") : false;
      })()`,
    );
  check(
    "Pause is offered",
    await view.evaluate<boolean>(button(".events-actions", "Pause", false)),
    pageConsole,
  );
  checkEqual("and has no aria-pressed", await pressedOf("Pause"), null);
  check(
    "clicking it turns its label to Resume",
    (await view.evaluate<boolean>(button(".events-actions", "Pause", true))) &&
      (await view.evaluate<boolean>(
        button(".events-actions", "Resume", false),
      )),
  );
  checkEqual(
    "Resume has no aria-pressed either",
    await pressedOf("Resume"),
    null,
  );
  check(
    "and clicking it brings Pause back",
    (await view.evaluate<boolean>(button(".events-actions", "Resume", true))) &&
      (await view.evaluate<boolean>(button(".events-actions", "Pause", false))),
  );

  /* ---------------------------------------------------------------- */
  step("Reduced motion: transitions collapse, the spinner turns slower");

  await open("/");
  // Two elements the stylesheets animate, added page-side so neither has to
  // be caught mid-load: the spinner, and the JSON tree's caret.
  const MOTION = `(() => {
    const main = document.getElementById("main");
    const spinner = main.appendChild(document.createElement("span"));
    spinner.className = "spinner";
    const caret = main.appendChild(document.createElement("span"));
    caret.className = "json-caret";
    const spin = getComputedStyle(spinner);
    const result = {
      reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
      spin: spin.animationDuration + " " + spin.animationIterationCount,
      caret: getComputedStyle(caret).transitionDuration,
    };
    spinner.remove();
    caret.remove();
    return result;
  })()`;
  const normal = await view.evaluate<Record<string, unknown>>(MOTION);
  await view.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const reduced = await view.evaluate<Record<string, unknown>>(MOTION);
  await view.cdp("Emulation.setEmulatedMedia", { features: [] });
  show("normal", normal);
  show("reduced", reduced);
  checkEqual(
    "normally: the spinner turns every 0.8s, the caret eases over 0.1s",
    normal,
    { reduce: false, spin: "0.8s infinite", caret: "0.1s" },
  );
  checkEqual(
    "reduced: the caret's transition is 0.01ms, the spinner still turns, every 2.4s",
    reduced,
    { reduce: true, spin: "2.4s infinite", caret: "1e-05s" },
  );

  /* ---------------------------------------------------------------- */
  step("A screen that crashes: screen-error, and the app around it survives");

  await open(`/queues/${QUEUE}/jobs/${GARBLED_ID}`);
  check(
    "the garbled job shows data-testid=screen-error",
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="screen-error"]'),
    ),
    pageConsole,
  );
  checkEqual(
    'its h1 is "This screen failed to show", the page\'s only one, in a role=alert',
    [
      await view.evaluate<string[]>(H1S),
      await view.evaluate<boolean>(
        `document.querySelector('[data-testid="screen-error"] [role="alert"] h1') !== null`,
      ),
    ],
    [["This screen failed to show"], true],
  );
  check(
    "the header's badge and the nav are still there",
    (await view.evaluate<boolean>(
      waitForSelector('[data-testid="live-status"]', 0),
    )) && (await view.evaluate<boolean>(waitForSelector(queuesLink, 0))),
  );
  show("garbled answers sent", garbledAnswers);

  check(
    '"Reload this screen" is offered',
    await view.evaluate<boolean>(
      button('[data-testid="screen-error"]', "Reload this screen", false),
    ),
  );

  // "Reload this screen" mounts the screen again, but over the same query
  // cache: the garbled answer is still there, the screen draws it before
  // any refetch, and crashes again. It recovers a transient crash (a screen
  // chunk that failed to load, a render bug the next state avoids), not a
  // bad answer still cached. Reloading the page starts a fresh cache.
  garble = false;
  await view.reload();
  checkEqual(
    "with the host answering truthfully, a page reload draws the job",
    await view.evaluate<string | null>(textOf('[data-testid="job-id"]')),
    GARBLED_ID,
  );
  check(
    "and screen-error is gone",
    await view.evaluate<boolean>(gone('[data-testid="screen-error"]')),
  );

  /* ---------------------------------------------------------------- */
  step("The live-status announcer: it speaks when the state changes");

  await open("/");
  const ANNOUNCER = '[data-testid="live-status-announcer"]';
  check(
    'the badge reaches data-state="live"',
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="live-status"][data-state="live"]'),
    ),
    pageConsole,
  );
  checkEqual(
    "the announcer is a polite live region",
    await view.evaluate<string | null>(
      `document.querySelector(${JSON.stringify(ANNOUNCER)})?.getAttribute("aria-live") ?? null`,
    ),
    "polite",
  );
  const spoken = `document.querySelector(${JSON.stringify(ANNOUNCER)}).textContent`;
  checkEqual(
    "once live, it says so",
    await view.evaluate<string>(
      until(spoken, `(value) => value.includes("Live ·")`),
    ),
    "Live updates: Live · events: local",
  );

  // Stopping the host drops the socket; the client starts reconnecting.
  await closeHost();
  check(
    'with the host stopped, the badge turns data-state="reconnecting"',
    await view.evaluate<boolean>(
      waitForSelector('[data-testid="live-status"][data-state="reconnecting"]'),
    ),
    pageConsole,
  );
  checkEqual(
    "and the announcer says so",
    await view.evaluate<string>(
      until(spoken, `(value) => value.includes("Reconnecting")`),
    ),
    "Live updates: Reconnecting… · events: local",
  );
} catch (error) {
  console.log(`page console:\n${pageConsole.join("\n")}`);
  throw error;
} finally {
  await shutdown(view);
}

summary();
