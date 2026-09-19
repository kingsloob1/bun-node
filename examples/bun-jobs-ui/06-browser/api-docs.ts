/**
 * The API docs in a real browser: the app's own reference for the API's
 * OpenAPI and AsyncAPI documents, its permission markers and its try-it
 * panels, driven in headless Chrome against real `createJobsApi` hosts.
 *
 * ```bash
 * bun 06-browser/api-docs.ts
 * BUN_CHROME_PATH=/opt/chrome/chrome bun 06-browser/api-docs.ts
 * EXAMPLE_BROWSER=0 bun 06-browser/api-docs.ts   # skip on purpose
 * ```
 *
 * Like the other browser examples it drives Chrome through `Bun.WebView` and
 * **skips** (prints `skipped:` and exits 0) when there is no `Bun.WebView`,
 * no Chrome, or Chrome will not start.
 *
 * Three hosts over one set of jobs, each an API and the UI on its own port:
 *
 * | Host         | API                                      | UI                   |
 * |--------------|------------------------------------------|----------------------|
 * | `full`       | a socket; `authorize` refuses `queues.clean` | every section    |
 * | `docsOnly`   | as `full`                                | `sections: { manage: false }` |
 * | `socketless` | `websocket: false`, so no AsyncAPI document | every section     |
 *
 * What it shows:
 *
 * - **`/docs` is a landing page** (`data-testid="docs-home"`): a card for the
 *   HTTP reference, and one for the WebSocket reference only when `/meta`'s
 *   `docs.asyncapi` names a document. The viewer is the app's own: no
 *   Swagger bundle, nothing from a CDN, and the documents are read through
 *   the app's API client.
 * - **Every operation carries a permission marker** (`op-permission`, with
 *   `data-allowed`): "You have `queues.read`", "You lack `queues.clean`",
 *   from the untargeted `/meta/permissions`.
 * - **Try-it sends through the app's client.** A GET runs at once and shows
 *   the parsed body. The status it shows on success is the **documented**
 *   one (the client returns the body, not the response), while a failure's
 *   status and problem `code` are the real ones: a queue that does not exist
 *   shows `404` and `QUEUE_NOT_FOUND`.
 * - **Every mutation asks first.** Pause asks with a plain confirmation;
 *   Drain, a `drain` verb, also needs its operationId typed before its
 *   confirm button enables. Sent, it drains the queue for real.
 * - **A try-it the caller may not send is disabled, with the reason**, not
 *   hidden: on `cleanQueue`, whose `queues.clean` this `authorize` refuses,
 *   `tryit-disabled` says "You do not have the queues.clean permission." and
 *   Send is disabled. This is the docs' one exception to the app's "absent,
 *   not disabled" rule.
 * - **`readOnly` is not shown here, because a real API cannot show it.** The
 *   UI disables a mutation's Send on a read-only API ("This API is
 *   read-only…"), but a read-only `createJobsApi` prunes its mutation routes,
 *   and its OpenAPI document describes only what it routes, so there is no
 *   mutation page to disable. `04-screens/permissions.ts` checks that, and
 *   states the rule on the model.
 * - **The WebSocket reference's panels** come from the document's
 *   extensions: `limits` (`ws-limit-<name>`), `close-codes`
 *   (`ws-close-<code>`), every code the document lists. A message's page
 *   shows its `examples` (`ws-example`) with a Copy JSON button, and the
 *   server panel names the subprotocol (`ws-subprotocol`) and where the
 *   document states it (`ws-subprotocol-source`: for `createJobsApi`,
 *   "from servers.api (x-bun-jobs-subprotocol)", read from the AsyncAPI
 *   document it serves).
 * - **WebSocket try-it opens the Events console.** On a channel's page each
 *   parameter is held to its `x-bun-jobs-schema` (`ws-parameter-schema-queue`
 *   draws it): `..` disables the link (`ws-try-disabled`, with the reason in
 *   `ws-try-reason`); `mail` makes it a link to
 *   `/events?channel=queue/mail`, and following it opens the console on that
 *   channel. The connection channel has no try-it at all, not even a
 *   disabled one: there is nothing to subscribe to.
 * - **A docs-only UI** (`sections.manage` off) has the docs and nothing else:
 *   `/` lands on `/docs`, the badge reads `Live off` (`data-state="off"`),
 *   and a channel's try-it is a note (`ws-try-unavailable`), since there is
 *   no Events console to open.
 * - **A host without a socket** has no AsyncAPI document: `/docs` shows no
 *   WebSocket card, and `/docs/ws` says "This API has no live-events socket".
 * - **Wait on conditions, never on time.** Every page-side helper polls the
 *   DOM until what it wants is there.
 */
import type { JobsApiAuthorize } from "@kingsleyweb/bun-jobs";
import type { UiSections } from "@kingsleyweb/bun-jobs-ui";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
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

/** The queue the try-it panels act on. */
const QUEUE = "mail";

const jobs = new BunJobs({
  namespace: "examples-ui-api-docs",
  driver: new MemoryDriver(),
  logger: noopLogger,
});
// Three waiting jobs, for Drain to remove.
for (const id of ["one", "two", "three"]) {
  await jobs.queue(QUEUE).add("send-email", { id }, { jobId: id });
}

/**
 * Every read, and every mutation but `queues.clean`: so `cleanQueue`'s
 * try-it is disabled with its reason, and the rest can be sent.
 */
const authorize: JobsApiAuthorize = (_req, ctx) =>
  ctx.action === "queues.clean"
    ? { allow: false, reason: "cleaning is for the on-call team" }
    : true;

/** A host: an API and the UI on an adapter of their own, listening. */
interface Host {
  /** Its origin, e.g. `http://localhost:41234`. */
  origin: string;
  /** The UI's base path. */
  uiBase: string;
  /** The API's base path. */
  apiBase: string;
  /** The CSRF header the UI sends, or `null`. */
  csrfHeader: string | null;
  /** Stops it. */
  close: () => Promise<void>;
}

/** Serves an API over `jobs` and the UI on a fresh adapter on port 0. */
async function serveHost(
  options: {
    /** `false` builds the API with no socket, and so no AsyncAPI document. */
    websocket?: false;
    /** The UI's sections; both on when absent. */
    sections?: Partial<UiSections>;
  } = {},
): Promise<Host> {
  const api = createJobsApi({
    jobs,
    basePath: "/jobs-api",
    mode: "both",
    // Every action, the opt-ins included, so every operation is documented.
    actions: [...JOBS_API_ACTIONS],
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
    apiBase: api.basePath,
    csrfHeader: ui.config.csrfHeader,
    close: async () => {
      await app.close();
      await api.close();
    },
  };
}

const full = await serveHost();
const docsOnly = await serveHost({ sections: { manage: false, docs: true } });
const socketless = await serveHost({ websocket: false });
const hosts = [full, docsOnly, socketless];

/** Winds everything down. */
async function shutdown(view?: Bun.WebView): Promise<void> {
  view?.close();
  for (const host of hosts) {
    await host.close();
  }
  await jobs.close();
}

/** A JSON read from `host`'s API, bypassing the page. */
async function read<T>(host: Host, path: string): Promise<T> {
  const response = await fetch(`${host.origin}${host.apiBase}${path}`);
  return (await response.json()) as T;
}

/** The OpenAPI operation fields this example reads. */
interface OpenApiOperation {
  /** Its id. */
  operationId?: string;
  /** Its responses, by status. */
  responses?: Record<string, unknown>;
}

// The documents, read the way the app reads them, to know what to expect.
const openapi = await read<{
  paths: Record<string, Record<string, OpenApiOperation>>;
}>(full, "/openapi.json");
const asyncapi = await read<{
  channels: Record<string, Record<string, unknown>>;
  servers?: Record<string, Record<string, unknown>>;
}>(full, "/asyncapi.json");

/**
 * Where this API's document states its subprotocol, in the words the server
 * panel's `ws-subprotocol-source` uses, found the way the UI looks: the
 * `x-bun-jobs-subprotocol` extension on `servers.api` (else the first
 * server), then on the connection channel, then the connection channel's
 * description, else the client contract's default.
 */
function subprotocolSource(): string {
  const servers = asyncapi.servers ?? {};
  const serverKey = "api" in servers ? "api" : Object.keys(servers)[0];
  const connection = asyncapi.channels.connection ?? {};
  if (
    serverKey !== undefined &&
    typeof servers[serverKey]?.["x-bun-jobs-subprotocol"] === "string"
  ) {
    return `from servers.${serverKey} (x-bun-jobs-subprotocol)`;
  }
  if (typeof connection["x-bun-jobs-subprotocol"] === "string") {
    return "from the connection channel (x-bun-jobs-subprotocol)";
  }
  if (/subprotocol `[^`]+`/.test(String(connection.description ?? ""))) {
    return "from the connection channel's description";
  }
  return "not stated; the client default";
}

/** An operation's documented 2xx statuses, as try-it shows them (`200 / 202`). */
function documentedSuccess(operationId: string): string {
  for (const item of Object.values(openapi.paths)) {
    for (const operation of Object.values(item)) {
      if (operation?.operationId === operationId) {
        return Object.keys(operation.responses ?? {})
          .filter((status) => /^2\d\d$/.test(status))
          .sort()
          .join(" / ");
      }
    }
  }
  throw new Error(`the document has no operation ${operationId}`);
}

/** The connection channel's `x-bun-jobs-close-codes`, by code. */
const closeCodes = (
  (asyncapi.channels.connection?.["x-bun-jobs-close-codes"] ?? []) as {
    code: number;
  }[]
).map((entry) => entry.code);
/** The connection channel's `x-bun-jobs-limits` names. */
const limitNames = Object.keys(
  (asyncapi.channels.connection?.["x-bun-jobs-limits"] ?? {}) as object,
).filter((name) => name !== "replay");

/* --- the browser: skip, not fail, if Chrome will not start --------- */

/** What the page printed to its console, for a failure's diagnosis. */
const pageConsole: string[] = [];
const view = await openView(chromePath, pageConsole, shutdown);

title("The API docs, in Chrome");
show("Chrome", chromePath);
show("serving", `${full.origin}${full.uiBase}/docs`);

/* --- page-side helpers --------------------------------------------- */

/** Page-side: `location.pathname + location.search`. */
const LOCATION = "location.pathname + location.search";

/**
 * Page-side: resolves `true` once `selector`'s text includes `text`,
 * `false` after `ms`.
 */
function textIncludes(selector: string, text: string, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (element && element.textContent.includes(${JSON.stringify(text)})) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** Page-side: an attribute of `selector`, or `null`. */
function attribute(selector: string, name: string): string {
  return `document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`;
}

/**
 * Page-side: an attribute of `selector` once it is non-empty, or `null`
 * after `ms`.
 */
function filledAttribute(selector: string, name: string, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      const value = document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)});
      if (value) return resolve(value);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** Page-side: the `href` of every link inside `selector`. */
function hrefsIn(selector: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(`${selector} a[href]`)})]
    .map((link) => link.getAttribute("href"))`;
}

/**
 * Page-side: whether a button whose text is `text` exists inside `scope`
 * and is disabled, waiting up to `ms` for one to appear.
 */
function disabledButton(scope: string, text: string, ms = 10_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const attempt = () => {
      for (const candidate of document.querySelectorAll(${JSON.stringify(`${scope} button`)})) {
        if (candidate.textContent.trim() === ${JSON.stringify(text)}) return resolve(candidate.disabled);
      }
      if (Date.now() > deadline) return resolve(null);
      setTimeout(attempt, 50);
    };
    attempt();
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

/** The open dialog. */
const DIALOG = "dialog[open]";

/** Opens `path` under `host`'s UI and waits for the app to boot. */
async function open(host: Host, path: string): Promise<boolean> {
  await view.navigate(`${host.origin}${host.uiBase}${path}`);
  return view.evaluate<boolean>(waitForSelector('[data-testid="app-ready"]'));
}

/**
 * Types `text` into the input `selector` as a user would: scrolled into
 * view, clicked (three times with `replace`, selecting what is there, so
 * the text replaces it), then typed.
 */
async function typeInto(
  selector: string,
  text: string,
  replace = false,
): Promise<void> {
  await view.scrollTo(selector, { timeout: 15_000 });
  await view.click(selector, {
    timeout: 15_000,
    ...(replace ? { clickCount: 3 as const } : {}),
  });
  await view.type(text);
}

/** Waits for `selector`; `ms` 0 asks whether it is there right now. */
function present(selector: string, ms?: number): Promise<boolean> {
  return view.evaluate<boolean>(waitForSelector(selector, ms));
}

/**
 * {@link present} for each selector, one after the other: a view runs one
 * `evaluate()` at a time.
 */
async function presentEach(selectors: readonly string[]): Promise<boolean[]> {
  const found: boolean[] = [];
  for (const selector of selectors) {
    found.push(await present(selector));
  }
  return found;
}

try {
  /* ---------------------------------------------------------------- */
  step("/docs: an HTTP card and a WebSocket card");

  check("the app is ready", await open(full, "/docs"), pageConsole);
  check("docs-home renders", await present('[data-testid="docs-home"]'));
  checkEqual(
    "its two cards link the HTTP and the WebSocket reference",
    await view.evaluate<string[]>(hrefsIn('[data-testid="docs-home"]')),
    [`${full.uiBase}/docs/http`, `${full.uiBase}/docs/ws`],
  );
  check(
    "and the nav has an API docs entry",
    await present(`nav a[href="${full.uiBase}/docs"]`),
  );

  /* ---------------------------------------------------------------- */
  step("An operation's permission marker");

  await view.click(`a[href="${full.uiBase}/docs/http"]`, { timeout: 15_000 });
  check(
    "the HTTP reference renders",
    await present('[data-testid="http-docs"]'),
  );
  await open(full, "/docs/http/getQueue");
  check(
    'getQueue: "You have queues.read"',
    await view.evaluate<boolean>(
      textIncludes('[data-testid="op-permission"]', "You have queues.read"),
    ),
  );
  checkEqual(
    "with data-allowed true",
    await view.evaluate<string | null>(
      attribute('[data-testid="op-permission"]', "data-allowed"),
    ),
    "true",
  );
  await open(full, "/docs/http/cleanQueue");
  check(
    'cleanQueue: "You lack queues.clean", from the untargeted map',
    await view.evaluate<boolean>(
      textIncludes('[data-testid="op-permission"]', "You lack queues.clean"),
    ),
  );

  /* ---------------------------------------------------------------- */
  step("A try-it the caller may not send: disabled, with the reason");

  checkEqual(
    "tryit-disabled gives the reason",
    await view.evaluate<string | null>(
      textOf('[data-testid="tryit-disabled"]'),
    ),
    "You do not have the queues.clean permission.",
  );
  checkEqual(
    "and Send POST is there, disabled, not absent",
    await view.evaluate<boolean | null>(
      disabledButton('[data-testid="tryit"]', "Send POST"),
    ),
    true,
  );

  /* ---------------------------------------------------------------- */
  step("Try-it on a GET: the body, and the documented status");

  await open(full, "/docs/http/getQueue");
  await typeInto('[data-testid="tryit"] input', QUEUE);
  check(
    "Send GET",
    await view.evaluate<boolean>(
      button('[data-testid="tryit"]', "Send GET", true),
    ),
  );
  check(
    "a response arrives",
    await present('[data-testid="tryit-result"]'),
    pageConsole,
  );
  checkEqual(
    `its status is the documented ${documentedSuccess("getQueue")}`,
    await view.evaluate<string | null>(textOf('[data-testid="tryit-status"]')),
    documentedSuccess("getQueue"),
  );
  check(
    "and the panel says so: the documented status, not the response's",
    await view.evaluate<boolean>(
      textIncludes(
        '[data-testid="tryit-result"]',
        "The status shown is the documented one",
      ),
    ),
  );
  check(
    `the body is the queue: it names "${QUEUE}"`,
    await view.evaluate<boolean>(
      textIncludes('[data-testid="tryit-result"]', `"${QUEUE}"`),
    ),
  );
  check(
    "and the snippets show the request, under the API's base",
    await view.evaluate<boolean>(
      textIncludes(
        '[data-testid="snippet-curl"]',
        `${full.origin}${full.apiBase}/queues/${QUEUE}`,
      ),
    ),
  );

  // A failure's status and code are the real ones.
  await open(full, "/docs/http/getQueue");
  await typeInto('[data-testid="tryit"] input', "nope");
  await view.evaluate<boolean>(
    button('[data-testid="tryit"]', "Send GET", true),
  );
  check(
    "a queue that does not exist: the real 404, and QUEUE_NOT_FOUND",
    (await view.evaluate<boolean>(
      textIncludes('[data-testid="tryit-status"]', "404"),
    )) &&
      (await view.evaluate<boolean>(
        textIncludes('[data-testid="tryit-result"]', "QUEUE_NOT_FOUND"),
      )),
    pageConsole,
  );

  /* ---------------------------------------------------------------- */
  step("A mutation asks first; Drain needs its operationId typed");

  await open(full, "/docs/http/pauseQueue");
  if (full.csrfHeader !== null) {
    check(
      `the ${full.csrfHeader} header is the client's to add`,
      await view.evaluate<boolean>(
        textIncludes(
          '[data-testid="tryit-csrf"]',
          `The ${full.csrfHeader} header is added by the app's client.`,
        ),
      ),
    );
  }
  await typeInto('[data-testid="tryit"] input', QUEUE);
  await view.evaluate<boolean>(
    button('[data-testid="tryit"]', "Send POST", true),
  );
  check("Pause: a confirmation opens", await present(DIALOG));
  checkEqual(
    "with nothing to type, and Send POST enabled at once",
    [
      await present(`${DIALOG} input`, 0),
      await view.evaluate<boolean | null>(disabledButton(DIALOG, "Send POST")),
    ],
    [false, false],
  );
  await view.evaluate<boolean>(button(DIALOG, "Cancel", true));
  check(
    "cancelled, the queue is not paused",
    !(await read<{ paused: boolean }>(full, `/queues/${QUEUE}`)).paused,
  );

  await open(full, "/docs/http/drainQueue");
  await typeInto('[data-testid="tryit"] input', QUEUE);
  await view.evaluate<boolean>(
    button('[data-testid="tryit"]', "Send POST", true),
  );
  check("Drain: a confirmation opens", await present(DIALOG));
  check(
    'it asks for "drainQueue" typed',
    await view.evaluate<boolean>(
      textIncludes(DIALOG, "Type drainQueue to confirm"),
    ),
  );
  checkEqual(
    "and its Send POST is disabled until it is",
    await view.evaluate<boolean | null>(disabledButton(DIALOG, "Send POST")),
    true,
  );
  // The dialog focuses its text box.
  await view.type("drainQueue");
  check(
    "typed: Send POST enables, and is clicked",
    await view.evaluate<boolean>(button(DIALOG, "Send POST", true)),
  );
  check(
    `the result shows the documented ${documentedSuccess("drainQueue")}`,
    await view.evaluate<boolean>(
      textIncludes(
        '[data-testid="tryit-status"]',
        documentedSuccess("drainQueue"),
      ),
    ),
    pageConsole,
  );
  checkEqual(
    "and the API says the queue was drained",
    (await read<{ counts: { waiting: number } }>(full, `/queues/${QUEUE}`))
      .counts.waiting,
    0,
  );

  /* ---------------------------------------------------------------- */
  step("The WebSocket reference: limits, close codes, a message's example");

  await open(full, "/docs/ws");
  checkEqual(
    "with no item, the connection channel is shown",
    await view.evaluate<string | null>(
      filledAttribute('[data-testid="ws-main"]', "data-selected"),
    ),
    "channel-connection",
  );
  checkEqual(
    "the subprotocol, from x-bun-jobs-subprotocol",
    await view.evaluate<string | null>(
      textOf('[data-testid="ws-subprotocol"]'),
    ),
    "bun-jobs.v1",
  );
  const source = subprotocolSource();
  show("the AsyncAPI document states it", source);
  checkEqual(
    "and ws-subprotocol-source names where the document states it",
    await view.evaluate<string | null>(
      textOf('[data-testid="ws-subprotocol-source"]'),
    ),
    source,
  );
  check(
    "which, for createJobsApi, is servers.api's x-bun-jobs-subprotocol",
    source === "from servers.api (x-bun-jobs-subprotocol)",
    source,
  );
  check(
    "the connection channel has no try-it: there is nothing to subscribe to",
    !(await present('[data-testid="ws-try-channel"]', 0)) &&
      !(await present('[data-testid="ws-try-disabled"]', 0)) &&
      !(await present('[data-testid="ws-try-unavailable"]', 0)),
  );
  await open(full, "/docs/ws/limits");
  checkEqual(
    `the limits panel has a row per x-bun-jobs-limits entry (${limitNames.length}), and replay`,
    await presentEach(
      [...limitNames, "replay"].map(
        (name) => `[data-testid="ws-limit-${name}"]`,
      ),
    ),
    [...limitNames, "replay"].map(() => true),
  );
  await open(full, "/docs/ws/close-codes");
  checkEqual(
    `the close-codes panel has every code the document lists (${closeCodes.join(", ")})`,
    await presentEach(
      closeCodes.map((code) => `[data-testid="ws-close-${code}"]`),
    ),
    closeCodes.map(() => true),
  );
  await open(full, "/docs/ws/message-queue.completed");
  check(
    "message-queue.completed shows an example",
    await present('[data-testid="ws-example"]'),
  );
  show(
    "its name",
    await view.evaluate<string | null>(
      textOf('[data-testid="ws-example-name"]'),
    ),
  );
  check(
    "with its event.payload first, and a Copy JSON button",
    (await present('[data-testid="ws-example-event-payload"]')) &&
      (await present(
        '[data-testid="ws-example"] button[aria-label^="Copy example"]',
      )),
  );

  /* ---------------------------------------------------------------- */
  step('WebSocket try-it: "Open in the Events console"');

  await open(full, "/docs/ws/channel-queue");
  check(
    "the queue parameter's x-bun-jobs-schema is drawn",
    await present('[data-testid="ws-parameter-schema-queue"]'),
  );
  await typeInto('[data-testid="ws-try-channel"] input', "..");
  check(
    '"..", which the schema refuses: the link is disabled',
    await present('[data-testid="ws-try-disabled"]'),
  );
  check(
    "and ws-try-reason says why",
    await view.evaluate<boolean>(
      textIncludes('[data-testid="ws-try-reason"]', "queue:"),
    ),
  );
  // Select what was typed, and type over it.
  await typeInto('[data-testid="ws-try-channel"] input', QUEUE, true);
  check(
    `"${QUEUE}": a link to the console on queue/${QUEUE}`,
    await present('[data-testid="ws-try-link"]'),
  );
  checkEqual(
    "its href",
    await view.evaluate<string | null>(
      attribute('[data-testid="ws-try-link"]', "href"),
    ),
    `${full.uiBase}/events?channel=queue%2F${QUEUE}`,
  );
  await view.click('[data-testid="ws-try-link"]');
  check(
    "followed, the Events console opens",
    await present('[data-testid="events-screen"]'),
  );
  checkEqual(
    "on that channel",
    [
      await view.evaluate<string>(LOCATION),
      await view.evaluate<string | null>(
        textOf('[data-testid="events-channel"]'),
      ),
    ],
    [`${full.uiBase}/events?channel=queue%2F${QUEUE}`, `queue/${QUEUE}`],
  );
  checkEqual(
    "no CSP violation on the full host",
    await view.evaluate<string[]>(COLLECT_VIOLATIONS),
    [],
  );

  /* ---------------------------------------------------------------- */
  step("A docs-only UI: the docs work, and the badge reads Live off");

  check("the app is ready", await open(docsOnly, "/"), pageConsole);
  check(
    "/ lands on the docs",
    await present('[data-testid="docs-home"]'),
    await view.evaluate<string>(LOCATION),
  );
  checkEqual(
    "the nav has the API docs entry and nothing else",
    await view.evaluate<string[]>(hrefsIn("nav")),
    [`${docsOnly.uiBase}/docs`],
  );
  check(
    'the badge is data-state="off"',
    await present('[data-testid="live-status"][data-state="off"]'),
  );
  checkEqual(
    'and reads "Live off"',
    await view.evaluate<string | null>(textOf('[data-testid="live-status"]')),
    "Live off",
  );
  await open(docsOnly, "/docs/http/getQueue");
  check(
    "an operation's page works, marker and all",
    await view.evaluate<boolean>(
      textIncludes('[data-testid="op-permission"]', "You have queues.read"),
    ),
  );
  await open(docsOnly, "/docs/ws/channel-queue");
  check(
    "a channel's try-it is a note: no Events console here",
    await present('[data-testid="ws-try-unavailable"]'),
  );
  check("and no link", !(await present('[data-testid="ws-try-link"]', 0)));

  /* ---------------------------------------------------------------- */
  step("A host without a socket: no AsyncAPI document");

  check("the app is ready", await open(socketless, "/docs"), pageConsole);
  check("docs-home renders", await present('[data-testid="docs-home"]'));
  checkEqual(
    "only the HTTP card",
    await view.evaluate<string[]>(hrefsIn('[data-testid="docs-home"]')),
    [`${socketless.uiBase}/docs/http`],
  );
  await open(socketless, "/docs/ws");
  check(
    '/docs/ws: "This API has no live-events socket"',
    await view.evaluate<boolean>(
      textIncludes(
        '[data-testid="ws-docs"]',
        "This API has no live-events socket",
      ),
    ),
  );
  checkEqual(
    "no CSP violation",
    await view.evaluate<string[]>(COLLECT_VIOLATIONS),
    [],
  );
} catch (error) {
  console.log(`page console:\n${pageConsole.join("\n")}`);
  throw error;
} finally {
  await shutdown(view);
}

summary();
