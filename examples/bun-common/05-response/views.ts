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
 * - A response renders through its application's `BunViews`: the `views`
 *   option of `new BunHttpAdapter(timeout, { views })` or
 *   `new BunRouter({ views })`, else the adapter's or router's own
 *   (`adapter.views`, which `setBaseViewsDir()`, `setViewEngine()`,
 *   `engine()`, `setLocal()` and `set()` configure). Every response gets that
 *   one instance — a served request's, `adapter.fetch()`'s, the error
 *   handlers' and `router.fetch()`'s — so the view cache and `locals` are
 *   shared. A router or adapter never configured renders with Express's
 *   defaults: `./views`, no engine registered and no default engine.
 * - The view cache (`cache`, Express's `view cache`) keeps each name's
 *   resolved view — the file found and its engine — so a cached name is never
 *   looked up again. Engines are told too (the `cache` local), and ejs-like
 *   ones keep the compiled template.
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
  RenderCallback,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BunHttpAdapter,
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

const app = new BunHttpAdapter(0, { views });
checkEqual("adapter.views is the option given", app.views, views);

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

await app.listen(0);

/** Status, Content-Type and body of `path` on the app, served. */
async function get(
  path: string,
  method = "GET",
): Promise<[number, string | null, string]> {
  const response = await fetch(`${app.url}${path}`, { method });
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

const headResponse = await fetch(`${app.url}/home`, {
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

await app.close();

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
step("One BunViews for the app: every response shares its cache");

// A template in a directory of its own, removed after the first render: from
// then on only the view cache knows where it was. The engine, like ejs,
// compiles a template once per path when the `cache` local is set, and
// counts its reads.
const cacheDir = mkdtempSync(join(tmpdir(), "bun-common-views-cache-"));
await Bun.write(join(cacheDir, "page.tpl"), "<p>{{via}}</p>");
const compiled = new Map<string, string>();
let templateReads = 0;

/** `tplEngine`, compiling each template once while the cache is on. */
function cachingEngine(
  path: string,
  options: Record<string, unknown>,
  callback: RenderCallback,
): void {
  const local = (_match: string, key: string): string =>
    escapeHtml(options[key]);
  const fill = (text: string): string => text.replace(/\{\{(\w+)\}\}/g, local);
  const template = options.cache === true ? compiled.get(path) : undefined;
  if (template !== undefined) {
    callback(null, fill(template));
    return;
  }
  templateReads++;
  Bun.file(path)
    .text()
    .then((text) => {
      if (options.cache === true) {
        compiled.set(path, text);
      }
      callback(null, fill(text));
    })
    .catch((error: Error) => callback(error));
}

const shared = new BunViews();
shared.root = cacheDir;
shared.engine("tpl", cachingEngine);
shared.defaultEngine = "tpl";
shared.cache = true; // Express's "view cache"; on by default in production

const site = new BunHttpAdapter(0, { views: shared });
site.get("/page", (_req, res) => res.render("page", { via: "a route" }));
site.get("/boom", () => {
  throw new Error("boom");
});
// The adapter's error handlers get a response of their own, which renders
// through the same views.
site.setErrorHandler((_error, _req, res) => {
  res.status(500).render("page", { via: "setErrorHandler" });
});
await site.listen(0);
const testing = new BunRouter({ views: shared });
testing.get("/page", (_req, res) => {
  res.render("page", { via: "router.fetch()" });
});

/** Status, Content-Type and body of a response. */
async function seen(
  response: Response,
): Promise<[number, string | null, string]> {
  return [
    response.status,
    response.headers.get("Content-Type"),
    await response.text(),
  ];
}

checkEqual(
  "a served request renders page.tpl",
  await seen(await fetch(`${site.url}/page`)),
  [200, "text/html; charset=utf-8", "<p>a route</p>"],
);
rmSync(join(cacheDir, "page.tpl"));
checkEqual(
  "with the file gone: adapter.fetch() renders it from the cache",
  await seen(await site.fetch("/page")),
  [200, "text/html; charset=utf-8", "<p>a route</p>"],
);
checkEqual(
  "…setErrorHandler, served, renders it too",
  await seen(await fetch(`${site.url}/boom`)),
  [500, "text/html; charset=utf-8", "<p>setErrorHandler</p>"],
);
checkEqual(
  "…and through adapter.fetch()",
  await seen(await site.fetch("/boom")),
  [500, "text/html; charset=utf-8", "<p>setErrorHandler</p>"],
);
checkEqual(
  "…and a router given the same views, through router.fetch()",
  await seen(await testing.fetch("/page")),
  [200, "text/html; charset=utf-8", "<p>router.fetch()</p>"],
);
checkEqual("the template was read once in total", templateReads, 1);

// The control: views configured the same way, but another instance, have no
// cache entry, and look the file up.
const elsewhere = new BunViews();
elsewhere.root = cacheDir;
elsewhere.engine("tpl", cachingEngine);
elsewhere.defaultEngine = "tpl";
elsewhere.cache = true;
const separate = new BunRouter({ views: elsewhere });
separate.get("/page", (_req, res) => res.render("page", { via: "separate" }));
separate.use(((err, _req, res, _next) => {
  res.status(500).send((err as Error).message);
}) satisfies RouterErrorMiddlewareHandler);
checkEqual(
  "another BunViews, configured alike, cannot find the removed file",
  await (await separate.fetch("/page")).text(),
  `Failed to lookup view "page" in views directory "${cacheDir}"`,
);

await site.close();
rmSync(cacheDir, { recursive: true, force: true });

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
