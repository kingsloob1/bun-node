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
 * | Host         | API                                                   | UI                            |
 * |--------------|-------------------------------------------------------|-------------------------------|
 * | `full`       | a socket; `authorize` refuses `queues.clean` and rate-limits the queue `throttled`; `addableNames: ["send-email"]` | every section |
 * | `docsOnly`   | as `full`                                             | `sections: { manage: false }` |
 * | `socketless` | `websocket: false`, so no AsyncAPI document           | every section                 |
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
 * - **Try-it shows the real response**, sent through the app's client
 *   (`requestRaw`): the status received and its status text, the timing, the
 *   headers the browser lets the page see (`tryit-headers`, one
 *   `data-header` row each, `content-type` among them whenever there is a
 *   body), and the body. Every expected status is read from the OpenAPI
 *   document the API serves, not assumed: `getQueue` answers `200`,
 *   `addJob` `201` for a job it adds and `200` for a `jobId` it already has,
 *   `removeJob` `204` with no body. An error status is a response too: a
 *   queue that does not exist shows `404`, its problem code
 *   `QUEUE_NOT_FOUND`, and the problem banner.
 * - **An undocumented status gets a note** (`tryit-documented`: "Not a
 *   documented status. Documented success: 200."), and a documented one,
 *   error or not, gets none. The undocumented status is a real one: this
 *   host's `authorize` rate-limits the queue `throttled` by throwing an error
 *   with `status: 429`, and `createJobsApi` answers `429 RATE_LIMITED`,
 *   which `getQueue` does not document.
 * - **Every mutation asks first.** Pause and Add ask with a plain
 *   confirmation; Drain (a `drain` verb) and Remove (a `DELETE`) also need
 *   their operationId typed before the confirm button enables. Sent, they
 *   change the queue for real, and the API is read back to show it. Fail (a
 *   `POST`, but a `fail` verb: the job is dead for good) asks for `failJob`
 *   typed too; that one is cancelled.
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
 * - **The nav nests two entries under API docs**: HTTP API (`/docs/http`,
 *   always) and WebSocket API (`/docs/ws`, only when `/meta`'s
 *   `docs.asyncapi` names a document).
 * - **A host without a socket** has no AsyncAPI document: `/docs` shows no
 *   WebSocket card, the nav no WebSocket API entry, and `/docs/ws` says
 *   "This API has no live-events socket".
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
/** The job name try-it adds, and the one name this API lets it add. */
const JOB_NAME = "send-email";

// Three waiting jobs: `removeJob` removes "one", and Drain the rest.
for (const id of ["one", "two", "three"]) {
  await jobs.queue(QUEUE).add(JOB_NAME, { id }, { jobId: id });
}

/**
 * A queue name this host's `authorize` rate-limits, so a real request gets a
 * status its operation does not document.
 */
const THROTTLED = "throttled";

/**
 * Every read, and every mutation but `queues.clean`: so `cleanQueue`'s
 * try-it is disabled with its reason, and the rest can be sent.
 *
 * It also stands in for a rate limiter in the auth hook: an HTTP request
 * about the queue `throttled` throws an error carrying `status: 429`. A
 * throwing `authorize` propagates, and the API answers the status the error
 * names (`429`, code `RATE_LIMITED`), which no operation documents. That is
 * how a real `createJobsApi` answers an undocumented status here: nothing in
 * the page or the response is altered.
 */
const authorize: JobsApiAuthorize = (_req, ctx) => {
  if (ctx.transport === "http" && ctx.queue === THROTTLED) {
    throw Object.assign(new Error("Too many requests: try again shortly"), {
      status: 429,
    });
  }
  return ctx.action === "queues.clean"
    ? { allow: false, reason: "cleaning is for the on-call team" }
    : true;
};

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
    // This context defines no jobs, so by default nothing may be added:
    // name the one `addJob`'s try-it sends.
    addableNames: [JOB_NAME],
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

/** Every status an operation documents (`default` aside), from the served OpenAPI document. */
function documentedStatuses(operationId: string): string[] {
  for (const item of Object.values(openapi.paths)) {
    for (const operation of Object.values(item)) {
      if (operation?.operationId === operationId) {
        return Object.keys(operation.responses ?? {})
          .filter((status) => /^\d{3}$/.test(status))
          .sort();
      }
    }
  }
  throw new Error(`the document has no operation ${operationId}`);
}

/** An operation's documented 2xx statuses, as try-it's note names them (`200 / 201`). */
function documentedSuccess(operationId: string): string {
  return documentedStatuses(operationId)
    .filter((status) => status.startsWith("2"))
    .join(" / ");
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

/**
 * Types `text` into try-it's `index`th input (0 is the first), focusing it
 * page-side first: an operation with two path parameters has two inputs and
 * no selector that tells them apart.
 */
async function typeIntoInput(index: number, text: string): Promise<void> {
  await present('[data-testid="tryit"] input');
  const focused = await view.evaluate<boolean>(`(() => {
    const input = document.querySelectorAll('[data-testid="tryit"] input')[${index}];
    if (!input) return false;
    input.scrollIntoView({ block: "center" });
    input.focus();
    return document.activeElement === input;
  })()`);
  if (!focused) {
    throw new Error(`try-it has no input ${index}`);
  }
  await view.type(text);
}

/**
 * Replaces try-it's JSON body with `json`: the textarea is focused and its
 * text selected page-side (a Ctrl+A chord is sent as raw key events, which
 * headless Chrome does not turn into select-all), then `json` is typed over
 * the selection.
 */
async function replaceBody(json: string): Promise<void> {
  await present('[data-testid="tryit"] textarea');
  const selected = await view.evaluate<boolean>(`(() => {
    const area = document.querySelector('[data-testid="tryit"] textarea');
    if (!area) return false;
    area.scrollIntoView({ block: "center" });
    area.focus();
    area.select();
    return document.activeElement === area;
  })()`);
  if (!selected) {
    throw new Error("try-it has no body to replace");
  }
  await view.type(json);
}

/**
 * Page-side: resolves `true` once `selector`'s trimmed text is exactly
 * `text`, `false` after `ms`. For a status, where "200" must not match a
 * "201" still showing from the send before.
 */
function textIs(selector: string, text: string, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (element && element.textContent.trim() === ${JSON.stringify(text)}) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** Try-it's status badge. */
const STATUS = '[data-testid="tryit-status"]';
/** Try-it's result. */
const RESULT = '[data-testid="tryit-result"]';
/** The problem banner inside the result, shown for an error status. */
const BANNER = `${RESULT} [role="alert"]`;
/** The note shown when the status received is not a documented one. */
const DOCUMENTED = '[data-testid="tryit-documented"]';
/** The `Content-Type` row of the result's headers. */
const CONTENT_TYPE_ROW =
  '[data-testid="tryit-headers"] [data-header="content-type"]';

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
  step("Try-it on a GET: the real response");

  // What the served document says getQueue answers, read, not assumed.
  const getQueueStatuses = documentedStatuses("getQueue");
  show("getQueue documents", getQueueStatuses.join(", "));
  await open(full, "/docs/http/getQueue");
  await typeInto('[data-testid="tryit"] input', QUEUE);
  check(
    "Send GET",
    await view.evaluate<boolean>(
      button('[data-testid="tryit"]', "Send GET", true),
    ),
  );
  check("a response arrives", await present(RESULT), pageConsole);
  check(
    "its status is the real 200, one getQueue documents",
    (await view.evaluate<boolean>(textIs(STATUS, "200"))) &&
      getQueueStatuses.includes("200"),
    await view.evaluate<string | null>(textOf(STATUS)),
  );
  check(
    'with its status text ("OK") and its timing',
    (await view.evaluate<boolean>(textIncludes(RESULT, "OK"))) &&
      /^\d+ ms$/.test(
        (await view.evaluate<string | null>(
          textOf('[data-testid="tryit-timing"]'),
        )) ?? "",
      ),
  );
  check(
    `the body is the queue: it names "${QUEUE}"`,
    await view.evaluate<boolean>(textIncludes(RESULT, `"${QUEUE}"`)),
  );
  check(
    "tryit-headers has the response's content-type row, application/json",
    await view.evaluate<boolean>(
      textIncludes(CONTENT_TYPE_ROW, "application/json"),
    ),
  );
  check(
    "a documented status: no tryit-documented note, and no banner",
    !(await present(DOCUMENTED, 0)) && !(await present(BANNER, 0)),
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

  // An error status is a response too: shown, not thrown.
  await open(full, "/docs/http/getQueue");
  await typeInto('[data-testid="tryit"] input', "nope");
  await view.evaluate<boolean>(
    button('[data-testid="tryit"]', "Send GET", true),
  );
  check(
    "a queue that does not exist: the real 404",
    await view.evaluate<boolean>(textIs(STATUS, "404")),
    pageConsole,
  );
  check(
    "its problem code, QUEUE_NOT_FOUND, and the banner",
    (await view.evaluate<boolean>(textIncludes(RESULT, "QUEUE_NOT_FOUND"))) &&
      (await view.evaluate<boolean>(
        textIncludes(BANNER, "QUEUE_NOT_FOUND · 404"),
      )),
  );
  check(
    "the problem body has a content-type row, application/problem+json",
    await view.evaluate<boolean>(
      textIncludes(CONTENT_TYPE_ROW, "application/problem+json"),
    ),
  );
  check(
    "404 is documented for getQueue: no tryit-documented note",
    getQueueStatuses.includes("404") && !(await present(DOCUMENTED, 0)),
  );

  // A status getQueue does not document, from the real API: this host's
  // `authorize` rate-limits the queue "throttled" (see `authorize` above).
  await open(full, "/docs/http/getQueue");
  await typeInto('[data-testid="tryit"] input', THROTTLED);
  await view.evaluate<boolean>(
    button('[data-testid="tryit"]', "Send GET", true),
  );
  check(
    `"${THROTTLED}": the real 429, which getQueue does not document`,
    (await view.evaluate<boolean>(textIs(STATUS, "429"))) &&
      !getQueueStatuses.includes("429"),
    pageConsole,
  );
  check(
    "with its problem code, RATE_LIMITED, in the banner",
    await view.evaluate<boolean>(textIncludes(BANNER, "RATE_LIMITED · 429")),
  );
  checkEqual(
    "and tryit-documented names the documented success",
    await view.evaluate<string | null>(textOf(DOCUMENTED)),
    `Not a documented status. Documented success: ${documentedSuccess("getQueue")}.`,
  );

  /* ---------------------------------------------------------------- */
  step("addJob: the real 201, and 200 when the job already exists");

  const addJobStatuses = documentedStatuses("addJob");
  show("addJob documents", addJobStatuses.join(", "));
  await open(full, "/docs/http/addJob");
  await typeInto('[data-testid="tryit"] input', QUEUE);
  await replaceBody(
    JSON.stringify({
      name: JOB_NAME,
      data: { id: "four" },
      opts: { jobId: "four" },
    }),
  );
  await view.evaluate<boolean>(
    button('[data-testid="tryit"]', "Send POST", true),
  );
  check("a confirmation opens", await present(DIALOG));
  await view.evaluate<boolean>(button(DIALOG, "Send POST", true));
  check(
    "sent: the real 201, a job added",
    (await view.evaluate<boolean>(textIs(STATUS, "201"))) &&
      addJobStatuses.includes("201"),
    await view.evaluate<string | null>(textOf(STATUS)),
  );
  check(
    "with a content-type row, and no tryit-documented note",
    (await present(CONTENT_TYPE_ROW)) && !(await present(DOCUMENTED, 0)),
  );
  check(
    "the API has the job",
    (await fetch(`${full.origin}${full.apiBase}/queues/${QUEUE}/jobs/four`))
      .status === 200,
  );
  // The same jobId again: not added twice, and the API says so with a 200.
  await view.evaluate<boolean>(
    button('[data-testid="tryit"]', "Send POST", true),
  );
  await view.evaluate<boolean>(button(DIALOG, "Send POST", true));
  check(
    "sent again: the real 200, the existing job, also documented",
    (await view.evaluate<boolean>(textIs(STATUS, "200"))) &&
      addJobStatuses.includes("200") &&
      !(await present(DOCUMENTED, 0)),
    await view.evaluate<string | null>(textOf(STATUS)),
  );

  /* ---------------------------------------------------------------- */
  step("removeJob: typed confirmation, then the real 204");

  const removeJobStatuses = documentedStatuses("removeJob");
  show("removeJob documents", removeJobStatuses.join(", "));
  await open(full, "/docs/http/removeJob");
  await typeIntoInput(0, QUEUE);
  await typeIntoInput(1, "one");
  check(
    "the request is DELETE …/queues/mail/jobs/one",
    await view.evaluate<boolean>(
      textIncludes(
        '[data-testid="snippet-curl"]',
        `${full.apiBase}/queues/${QUEUE}/jobs/one`,
      ),
    ),
  );
  await view.evaluate<boolean>(
    button('[data-testid="tryit"]', "Send DELETE", true),
  );
  check(
    'a DELETE is destructive: it asks for "removeJob" typed',
    await view.evaluate<boolean>(
      textIncludes(DIALOG, "Type removeJob to confirm"),
    ),
  );
  checkEqual(
    "and its Send DELETE is disabled until it is",
    await view.evaluate<boolean | null>(disabledButton(DIALOG, "Send DELETE")),
    true,
  );
  await view.type("removeJob");
  check(
    "typed: Send DELETE enables, and is clicked",
    await view.evaluate<boolean>(button(DIALOG, "Send DELETE", true)),
  );
  check(
    "the real 204, one removeJob documents",
    (await view.evaluate<boolean>(textIs(STATUS, "204"))) &&
      removeJobStatuses.includes("204"),
    pageConsole,
  );
  check(
    'no body ("No body."), so no content-type row, and no note',
    (await view.evaluate<boolean>(textIncludes(RESULT, "No body."))) &&
      !(await present(CONTENT_TYPE_ROW, 0)) &&
      !(await present(DOCUMENTED, 0)),
  );
  checkEqual(
    "and the API no longer has the job",
    (await fetch(`${full.origin}${full.apiBase}/queues/${QUEUE}/jobs/one`))
      .status,
    404,
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
    "the result shows the real 200, one drainQueue documents",
    (await view.evaluate<boolean>(textIs(STATUS, "200"))) &&
      documentedStatuses("drainQueue").includes("200"),
    pageConsole,
  );
  checkEqual(
    "and the API says the queue was drained",
    (await read<{ counts: { waiting: number } }>(full, `/queues/${QUEUE}`))
      .counts.waiting,
    0,
  );

  // failJob is a POST, but a failed job is dead for good: its `fail` verb
  // asks for the operationId typed, as a DELETE does. Cancelled, not sent.
  await open(full, "/docs/http/failJob");
  await typeIntoInput(0, QUEUE);
  await typeIntoInput(1, "two");
  await view.evaluate<boolean>(
    button('[data-testid="tryit"]', "Send POST", true),
  );
  checkEqual(
    'failJob (a fail verb) asks for "failJob" typed, its Send POST disabled until it is',
    [
      await view.evaluate<boolean>(
        textIncludes(DIALOG, "Type failJob to confirm"),
      ),
      await view.evaluate<boolean | null>(disabledButton(DIALOG, "Send POST")),
      await view.evaluate<boolean>(button(DIALOG, "Cancel", true)),
    ],
    [true, true, true],
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
    "the nav has only API docs, with its HTTP API and WebSocket API entries (this host has a socket)",
    await view.evaluate<string[]>(hrefsIn("nav")),
    [
      `${docsOnly.uiBase}/docs`,
      `${docsOnly.uiBase}/docs/http`,
      `${docsOnly.uiBase}/docs/ws`,
    ],
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
  check(
    "the nav has an HTTP API entry under API docs",
    await present(`nav a[href="${socketless.uiBase}/docs/http"]`),
    await view.evaluate<string[]>(hrefsIn("nav")),
  );
  check(
    "and no WebSocket API entry: /meta's docs name no AsyncAPI document",
    !(await present(`nav a[href="${socketless.uiBase}/docs/ws"]`, 0)),
    await view.evaluate<string[]>(hrefsIn("nav")),
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
