/**
 * Views — `res.render()`, `BunViews` and the `views` option: template
 * engines, view lookup, locals, the callback form, and every way a render
 * fails.
 *
 * ```bash
 * bun 05-response/views.ts
 * ```
 *
 * The templates live in `fixtures/views/`:
 *
 * ```text
 * home.tpl   who.tpl   email.tpl   users/index.tpl
 * ```
 *
 * Worth knowing before reading it:
 *
 * - `res.render(view, locals?, callback?)` is Express's. It renders through a
 *   `BunViews`, which holds Express's view settings in one object: `root`
 *   (`views`), `defaultEngine` (`view engine`), `cache` (`view cache`),
 *   `viewOptions` (`view options`), `engine(ext, fn)` (`app.engine`) and
 *   `locals` (`app.locals`).
 * - A response renders through the `BunViews` given as its constructor's
 *   `views` option. bun-common's `BunHttpAdapter` and `router.fetch()` give
 *   their responses none (bun-nest's adapter gives its own), so a
 *   `res.render()` there uses a fresh default: `./views`, no engine
 *   registered and no default engine. This example therefore builds each
 *   response itself, with `views`, and runs the router with `router.handle()`
 *   under `Bun.serve`, as the adapters do inside.
 * - An engine is Express's `(path, options, callback)`. The one here
 *   replaces `{{key}}` with the HTML-escaped local `key`.
 * - A view is looked up as `<root>/<name>.<ext>`, then as
 *   `<root>/<name>/index.<ext>`. A name without an extension takes the
 *   default engine's.
 * - The locals are `views.locals`, then `res.locals`, then the render's own:
 *   the last one to set a key wins. The engine also gets `settings` (the view
 *   settings) and `cache`.
 * - With no callback, the HTML is sent as `text/html; charset=utf-8` and a
 *   failure goes to `next(err)`. With a callback, it receives `(err, html)`
 *   and nothing is sent.
 * - Three failures throw from `res.render()` itself, callback or not, as in
 *   Express: a name with no extension and no default engine; an extension
 *   with no engine whose module (`require("<ext>")`) is missing or has no
 *   `__express`; and, unlike Express, a script extension (`.js`, `.ts`,
 *   `.tsx`, …) with no engine registered, which is never loaded as a module.
 *   In a route, the thrown error reaches the error handlers.
 * - A `HEAD` request gets the rendered page's `Content-Length` and no body.
 */
import type {
  BunServer,
  RenderCallback,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import {
  BunRequest,
  BunResponse,
  BunRouter,
  BunViews,
  FETCH_STUB_SERVER,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Views: res.render() and BunViews");

const ROOT = join(import.meta.dir, "fixtures", "views");

/** HTML-escapes a local before it goes into a template. */
function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => `&#${char.charCodeAt(0)};`,
  );
}

/** The options the engine was last called with, for the checks below. */
let lastOptions: Record<string, unknown> = {};

/** A tiny template engine: `{{key}}` becomes the escaped local `key`. */
function tplEngine(
  path: string,
  options: Record<string, unknown>,
  callback: RenderCallback,
): void {
  lastOptions = options;
  const fill = (_match: string, key: string): string =>
    escapeHtml(options[key]);
  Bun.file(path)
    .text()
    .then((text) => callback(null, text.replace(/\{\{(\w+)\}\}/g, fill)))
    .catch((error: Error) => callback(error));
}

/* ------------------------------------------------------------------ */
step("BunViews: where views live, the engine, app-wide locals");

const views = new BunViews();
views.root = ROOT;
views.engine("tpl", tplEngine); // or ".tpl"
views.defaultEngine = "tpl"; // so render("home") means home.tpl
views.locals.site = "example.test";
views.locals.who = "app.locals";

checkEqual(
  "settings: what engines read as Express's app settings",
  [
    views.settings.views,
    views.settings["view engine"],
    Object.keys(views.engines),
  ],
  [ROOT, "tpl", [".tpl"]],
);
await checkRejects(
  "engine() refuses anything but a function",
  () => views.engine("txt", "not a function" as never),
  { name: "TypeError", message: /^callback function required$/ },
);

/* ------------------------------------------------------------------ */
step("An app whose responses render through those views");

const app = new BunRouter();

app.get("/home", (_req, res) => {
  res.render("home", { title: "Welcome", name: "Zoë" });
});
app.get("/home-with-extension", (_req, res) => {
  res.render("home.tpl", { title: "Welcome", name: "Zoë" });
});
app.get("/users", (_req, res) => {
  res.render("users", { count: 3 });
});
app.get("/who/:level", (req, res) => {
  if (req.params.level !== "app") {
    res.locals.who = "res.locals";
  }
  res.render("who", req.params.level === "options" ? { who: "options" } : {});
});
app.get("/preview", (_req, res) => {
  res.render("home", { title: "Draft", name: "Ed" }, (err, html) => {
    res.json({ error: err?.message ?? null, html });
  });
});
app.get("/preview-missing", (_req, res) => {
  res.render("drafts/none", {}, (err, html) => {
    res.status(404).json({ error: err?.message ?? null, html: html ?? null });
  });
});
app.get("/missing", (_req, res) => {
  res.render("drafts/none");
});
app.get("/unknown-extension", (_req, res) => {
  res.render("page.nope");
});
app.get("/module-without-engine", (_req, res) => {
  res.render("page.path");
});
app.get("/script-extension", (_req, res) => {
  res.render("widget.ts");
});
app.use(((err, _req, res, _next) => {
  res
    .status(500)
    .json({ name: (err as Error).name, error: (err as Error).message });
}) satisfies RouterErrorMiddlewareHandler);

/**
 * Runs `app` for one request on a response given `views` — the adapter's
 * job, done by hand because bun-common's adapter passes no views.
 */
async function handle(native: Request, server: BunServer): Promise<Response> {
  const request = await BunRequest.init(native, server, { parseBody: false });
  const response = new BunResponse(request, { views });
  await app.handle({
    requestHost: request.host,
    requestMethod: request.method,
    requestUrl: request.originalUrl,
    request,
    response,
  });
  return await response.getNativeResponse(1000);
}

const server = Bun.serve({ port: 0, fetch: handle });

/** Status, Content-Type and body of `path` on the app. */
async function get(
  path: string,
  method = "GET",
): Promise<[number, string | null, string]> {
  const response = await fetch(new URL(path, server.url), { method });
  return [
    response.status,
    response.headers.get("Content-Type"),
    await response.text(),
  ];
}

const home = await get("/home");
show("GET /home", home);
checkEqual(
  "render(name): the default engine's extension, <root>/home.tpl, sent as HTML",
  home,
  [
    200,
    "text/html; charset=utf-8",
    "<h1>Welcome</h1><p>Hello Zoë, from example.test.</p>",
  ],
);
checkEqual(
  "render(name.ext): the same file, named in full",
  (await get("/home-with-extension"))[2],
  home[2],
);
checkEqual(
  "render(users): no users.tpl, so <root>/users/index.tpl",
  (await get("/users"))[2],
  "<ul>3 users</ul>",
);

/* ------------------------------------------------------------------ */
step("Locals: views.locals, then res.locals, then the render's own");

checkEqual(
  "`who` set at all three levels: the render's own wins",
  (await get("/who/options"))[2],
  "options",
);
checkEqual(
  "…in views.locals and res.locals: res.locals wins",
  (await get("/who/res"))[2],
  "res.locals",
);
checkEqual(
  "…in views.locals alone: views.locals",
  (await get("/who/app"))[2],
  "app.locals",
);
await get("/home");
checkEqual(
  "the engine also gets the view settings and the cache flag",
  [(lastOptions.settings as Record<string, unknown>).views, lastOptions.cache],
  [ROOT, views.cache],
);

/* ------------------------------------------------------------------ */
step("The callback form: the HTML, or the error, and nothing sent");

checkEqual(
  "render(view, locals, callback) hands over the HTML; the handler sends JSON",
  JSON.parse((await get("/preview"))[2]),
  {
    error: null,
    html: "<h1>Draft</h1><p>Hello Ed, from example.test.</p>",
  },
);
checkEqual(
  "…and the lookup error, for the handler to answer",
  await get("/preview-missing"),
  [
    404,
    "application/json;charset=utf-8",
    JSON.stringify({
      error: `Failed to lookup view "drafts/none" in views directory "${ROOT}"`,
      html: null,
    }),
  ],
);

/* ------------------------------------------------------------------ */
step("HEAD: the rendered length, no body");

const headResponse = await fetch(new URL("/home", server.url), {
  method: "HEAD",
});
checkEqual(
  "Content-Length is the page's byte length (ë is two bytes)",
  [
    headResponse.status,
    headResponse.headers.get("Content-Length"),
    await headResponse.text(),
  ],
  [200, String(Buffer.byteLength(home[2])), ""],
);

/* ------------------------------------------------------------------ */
step("Failures: a missing view, no engine, .nope, a script extension");

checkEqual(
  "a missing view, no callback: next(err) with Express's lookup error",
  JSON.parse((await get("/missing"))[2]),
  {
    name: "Error",
    error: `Failed to lookup view "drafts/none" in views directory "${ROOT}"`,
  },
);
const nope = JSON.parse((await get("/unknown-extension"))[2]) as {
  error: string;
};
check(
  '.nope, no engine: Express\'s require("nope") — the module is not found',
  nope.error.startsWith("Cannot find module 'nope'"),
  nope,
);
checkEqual(
  ".path, no engine: node:path loads but has no __express",
  JSON.parse((await get("/module-without-engine"))[2]),
  { name: "TypeError", error: 'Module "path" does not provide a view engine.' },
);
checkEqual(
  ".ts, no engine: refused, never loaded as a module",
  JSON.parse((await get("/script-extension"))[2]),
  {
    name: "Error",
    error:
      'No view engine registered for ".ts": register one with engine("ts", fn).',
  },
);

// The throws happen in res.render() itself, before any callback could run.
/** A response for a GET, rendering through `views`, outside any router. */
async function bareResponse(): Promise<BunResponse> {
  const request = await BunRequest.init(
    new Request("http://localhost/"),
    FETCH_STUB_SERVER,
    { parseBody: false },
  );
  return new BunResponse(request, { views });
}
let calledBack = false;
const scriptRes = await bareResponse();
await checkRejects(
  'res.render("widget.ts", locals, callback) throws too',
  () =>
    scriptRes.render("widget.ts", {}, () => {
      calledBack = true;
    }),
  {
    message:
      /^No view engine registered for "\.ts": register one with engine\("ts", fn\)\.$/,
  },
);
const nopeRes = await bareResponse();
await checkRejects(
  "…while .nope, with a callback, still takes the module lookup",
  () =>
    nopeRes.render("page.nope", {}, () => {
      calledBack = true;
    }),
  { message: /^Cannot find module 'nope'/ },
);
await Bun.sleep(0);
checkEqual("…and neither callback is called", calledBack, false);

server.stop(true);

/* ------------------------------------------------------------------ */
step("What a plain router gives res.render(): the default views");

const plain = new BunRouter();
plain.get("/no-extension", (_req, res) => {
  res.render("home");
});
plain.get("/registered-elsewhere", (_req, res) => {
  res.render("home.tpl");
});
plain.use(((err, _req, res, _next) => {
  res.status(500).send((err as Error).message);
}) satisfies RouterErrorMiddlewareHandler);

checkEqual(
  "no extension and no default engine: Express's error",
  await (await plain.fetch("/no-extension")).text(),
  "No default engine was specified and no extension was provided.",
);
const unregistered = await (await plain.fetch("/registered-elsewhere")).text();
check(
  'the engine registered on `views` above is not there: require("tpl") fails',
  unregistered.startsWith("Cannot find module 'tpl'"),
  unregistered,
);

/* ------------------------------------------------------------------ */
step("BunViews.render(): a template without a response");

// An email body, say: the same views, engine and app locals, no request.
// `_locals` is where res.locals would go — under the options, over
// views.locals.
const email = await new Promise<string | undefined>((resolve, reject) => {
  views.render(
    "email",
    { name: "Ada", code: "4071", _locals: { site: "mail.example.test" } },
    (err, rendered) => (err ? reject(err) : resolve(rendered)),
  );
});
checkEqual(
  "views.render(name, options, callback)",
  email,
  "Hi Ada, your code is 4071. (mail.example.test)",
);
const lookupError = await new Promise<Error | null>((resolve) => {
  views.render("nowhere", (err) => resolve(err));
});
checkEqual(
  "…a failed lookup is passed to the callback, not thrown",
  lookupError?.message,
  `Failed to lookup view "nowhere" in views directory "${ROOT}"`,
);

summary();
