/**
 * Views: `@Render()` and `res.render()` through a template engine, as on
 * `@nestjs/platform-express` — the views directory, the view engine, engines
 * registered with `engine(ext, fn)`, and the locals a template sees.
 *
 * ```bash
 * bun 02-http-adapter/views.ts
 * ```
 *
 * Worth knowing:
 *
 * - The setup is Express's: `app.setBaseViewsDir(dir)` is its `views`
 *   setting, `app.setViewEngine("tpl")` its `view engine`, and
 *   `adapter.engine("tpl", fn)` its `app.engine()`. The same three can be set
 *   with `adapter.set("views" | "view engine", …)`. This example registers a
 *   ten-line `{{name}}` engine of its own; ejs, pug, hbs or any engine with an
 *   `__express` export works the same way, loaded by name when no engine is
 *   registered for the extension — except a script extension (`.ts`, `.tsx`,
 *   `.js`, …), which needs its engine registered (`express-parity.ts`).
 * - `@Render("home")` looks for `home.tpl` in the views directory, then
 *   `home/index.tpl`.
 * - A template's locals are `app.locals` (`adapter.setLocal()`), then
 *   `res.locals` (here set by a middleware), then what the handler returned;
 *   a later level wins a key set at several.
 * - The status is the route's: `@HttpCode()` sets it, and a `status` the
 *   handler returns is only a local.
 * - A missing view, a name with no extension and no view engine set, and an
 *   extension no engine is registered or installed for all answer Nest's JSON
 *   500. `res.render(view, locals, callback)` hands the error to the callback
 *   (or throws it, for the last two), which is where its message can be read.
 * - `HEAD` to a `@Render()` route answers the rendered page's headers,
 *   `Content-Length` included, without the body.
 */
import type { BunResponse, ViewEngine } from "@kingsleyweb/bun-common";
import type { MiddlewareConsumer, NestModule } from "@nestjs/common";
import type { NestApplication } from "@nestjs/core";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Render,
  Res,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

title("Views: @Render() and res.render() on BunHttpAdapter");

/** The views directory: one template per lookup this example shows. */
const scratch = await mkdtemp(join(tmpdir(), "bun-nest-views-"));
const views = join(scratch, "views");
await Bun.write(join(views, "home.tpl"), "<h1>{{site}}: {{title}}</h1>");
await Bun.write(join(views, "blog", "index.tpl"), "<h1>{{site}} blog</h1>");
await Bun.write(
  join(views, "locals.tpl"),
  "who={{who}} site={{site}} user={{user}} title={{title}}",
);
await Bun.write(join(views, "status.tpl"), "status local={{status}}");
// A template with an extension no engine is registered or installed for.
await Bun.write(join(views, "page.nope"), "never rendered");

/** Every template this engine renders, in order, by file name. */
const rendered: string[] = [];

/**
 * A whole template engine: reads the file and replaces each `{{name}}` with
 * that local. Express's engine contract — `(path, locals, callback)`.
 */
const tpl: ViewEngine = (path, locals, callback) => {
  readFile(path, "utf8").then(
    (source) => {
      rendered.push(path.slice(views.length + 1));
      callback(
        null,
        source.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
          return String(locals[name] ?? "");
        }),
      );
    },
    (error: Error) => callback(error),
  );
};

@Controller()
class PagesController {
  /** `home.tpl`: the name, plus the view engine's extension. */
  @Get("home")
  @Render("home")
  home() {
    return { title: "Welcome" };
  }

  /** `blog/index.tpl`: no `blog.tpl`, so the directory's index. */
  @Get("blog")
  @Render("blog")
  blog() {
    return undefined;
  }

  /** `who` set at all three levels: the handler's wins. */
  @Get("locals/all")
  @Render("locals")
  allLevels() {
    return { who: "the handler", title: "All" };
  }

  /** The handler does not set `who`: `res.locals` wins over `app.locals`. */
  @Get("locals/res")
  @Render("locals")
  resLevel() {
    return { title: "Res" };
  }

  /** No middleware on this route and no `who` returned: `app.locals`'s. */
  @Get("app-locals")
  @Render("locals")
  appLevel() {
    return { title: "App" };
  }

  /** A returned `status` is a local, not the response's status. */
  @Get("status-local")
  @Render("status")
  statusLocal() {
    return { status: 201 };
  }

  /** `@HttpCode()` is how a rendered page gets another status. */
  @Get("http-code")
  @HttpCode(203)
  @Render("status")
  httpCode() {
    return { status: 203 };
  }

  /** No `nowhere.tpl` and no `nowhere/index.tpl`. */
  @Get("missing")
  @Render("nowhere")
  missing() {
    return {};
  }

  /** `page.nope` exists, but nothing renders `.nope`. */
  @Get("nope")
  @Render("page.nope")
  nope() {
    return {};
  }

  /** `res.render()` from `@Res()`: the same views and locals. */
  @Get("res-render")
  resRender(@Res() res: BunResponse) {
    res.render("home", { title: "from res.render()" });
  }

  /**
   * `res.render(view, locals, callback)`: the callback gets the error or the
   * HTML, and nothing is sent until the handler sends it. An engine that
   * cannot be found throws instead, as in Express.
   */
  @Get("why/:view")
  why(@Param("view") view: string, @Res() res: BunResponse) {
    try {
      res.render(view, {}, (error, html) => {
        res.json(error ? { error: error.message } : { html });
      });
    } catch (error) {
      res.json({ thrown: (error as Error).message });
    }
  }
}

@Module({ controllers: [PagesController] })
class ViewsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_req: unknown, res: BunResponse, next: () => void) => {
        res.locals.who = "res.locals";
        res.locals.user = "ada";
        next();
      })
      .forRoutes("locals/*path");
  }
}

/** A JSON-or-text summary of a response. */
async function read(response: Response) {
  const text = await response.text();
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    body: response.headers.get("content-type")?.includes("json")
      ? (JSON.parse(text) as unknown)
      : text,
  };
}

/** Nest's answer to an error it was not told about. */
const NEST_500 = {
  status: 500,
  type: "application/json;charset=utf-8",
  body: { statusCode: 500, message: "Internal server error" },
};

/* ------------------------------------------------------------------ */
step("setBaseViewsDir, setViewEngine, engine(ext, fn), setLocal");

const adapter = new BunHttpAdapter();
const app = await NestFactory.create<NestApplication>(ViewsModule, adapter, {
  logger: false,
});
app.setBaseViewsDir(views); // Express's `views`
app.setViewEngine("tpl"); // `view engine`: a name without an extension gets `.tpl`
adapter.engine("tpl", tpl); // `app.engine("tpl", fn)`
adapter.setLocal("site", "Acme").setLocal("who", "app.locals"); // `app.locals`
await app.init();

checkEqual(
  "the adapter's views carry the settings",
  {
    root: adapter.views.root,
    defaultEngine: adapter.views.defaultEngine,
    locals: { ...adapter.views.locals },
  },
  {
    root: views,
    defaultEngine: "tpl",
    locals: { site: "Acme", who: "app.locals" },
  },
);

const home = await read(await adapter.fetch("/home"));
show("GET /home", home);
checkEqual(
  "@Render('home') renders home.tpl with app.locals and the handler's",
  home,
  {
    status: 200,
    type: "text/html; charset=utf-8",
    body: "<h1>Acme: Welcome</h1>",
  },
);
checkEqual(
  "@Render('blog') falls back to blog/index.tpl; a handler returning nothing is a 200",
  await read(await adapter.fetch("/blog")),
  { status: 200, type: "text/html; charset=utf-8", body: "<h1>Acme blog</h1>" },
);
checkEqual(
  "res.render() from @Res() renders the same way",
  (await read(await adapter.fetch("/res-render"))).body,
  "<h1>Acme: from res.render()</h1>",
);

/* ------------------------------------------------------------------ */
step("Locals: app.locals, then res.locals, then the handler's");

const levels = {
  all: (await read(await adapter.fetch("/locals/all"))).body,
  res: (await read(await adapter.fetch("/locals/res"))).body,
  app: (await read(await adapter.fetch("/app-locals"))).body,
};
show("the three levels", levels);
checkEqual(
  "`who` is set at all three levels: the handler's wins",
  levels.all,
  "who=the handler site=Acme user=ada title=All",
);
checkEqual(
  "the handler leaves `who` alone: res.locals wins over app.locals",
  levels.res,
  "who=res.locals site=Acme user=ada title=Res",
);
checkEqual(
  "no middleware and no `who` returned: app.locals's",
  levels.app,
  "who=app.locals site=Acme user= title=App",
);

/* ------------------------------------------------------------------ */
step("The status is the route's");

checkEqual(
  "a returned { status: 201 } is a local: the response is still 200",
  await read(await adapter.fetch("/status-local")),
  { status: 200, type: "text/html; charset=utf-8", body: "status local=201" },
);
checkEqual(
  "@HttpCode(203) sets it",
  (await adapter.fetch("/http-code")).status,
  203,
);

/* ------------------------------------------------------------------ */
step("HEAD: the rendered page's headers, no body");

await app.listen(0);
const served = await fetch(`${await app.getUrl()}/home`, { method: "HEAD" });
const servedHead = {
  status: served.status,
  type: served.headers.get("content-type"),
  length: served.headers.get("content-length"),
  body: await served.text(),
};
show("HEAD /home", servedHead);
checkEqual("served HEAD /home", servedHead, {
  status: 200,
  type: "text/html; charset=utf-8",
  length: String(Buffer.byteLength("<h1>Acme: Welcome</h1>")),
  body: "",
});

/* ------------------------------------------------------------------ */
step("Failures: Nest's 500, and the error res.render() reports");

rendered.length = 0;
checkEqual(
  "a missing view is Nest's JSON 500",
  await read(await adapter.fetch("/missing")),
  NEST_500,
);
checkEqual(
  "…the callback form reports Express's lookup error",
  (await read(await adapter.fetch("/why/nowhere"))).body,
  { error: `Failed to lookup view "nowhere" in views directory "${views}"` },
);
checkEqual(
  "page.nope (no engine registered or installed for .nope) is Nest's JSON 500",
  await read(await adapter.fetch("/nope")),
  NEST_500,
);
const nopeWhy = (await read(await adapter.fetch("/why/page.nope"))).body as {
  thrown?: string;
};
check(
  "…res.render() throws: there is no module named `nope` to load an engine from",
  nopeWhy.thrown?.startsWith("Cannot find module 'nope'") === true,
  nopeWhy,
);
checkEqual(
  "an installed module without `__express` is not an engine",
  (await read(await adapter.fetch("/why/page.rxjs"))).body,
  { thrown: 'Module "rxjs" does not provide a view engine.' },
);
checkEqual("no template was rendered for any of them", rendered, []);
await app.close();

/* ------------------------------------------------------------------ */
step("No view engine set, and no extension on the name");

const bareAdapter = new BunHttpAdapter();
const bareApp = await NestFactory.create<NestApplication>(
  ViewsModule,
  bareAdapter,
  { logger: false },
);
bareApp.setBaseViewsDir(views);
bareAdapter.engine("tpl", tpl);
await bareApp.init();
checkEqual(
  "@Render('home') with no view engine is Nest's JSON 500",
  await read(await bareAdapter.fetch("/home")),
  NEST_500,
);
checkEqual(
  "…res.render() throws Express's error",
  (await read(await bareAdapter.fetch("/why/home"))).body,
  { thrown: "No default engine was specified and no extension was provided." },
);
checkEqual(
  "a name with the extension still renders",
  (await read(await bareAdapter.fetch("/why/home.tpl"))).body,
  { html: "<h1>: </h1>" },
);
await bareApp.close();

/* ------------------------------------------------------------------ */
step("set('views') and set('view engine') are the setters");

const setAdapter = new BunHttpAdapter();
setAdapter
  .set("views", views)
  .set("view engine", "tpl")
  .engine("tpl", tpl)
  .setLocal("site", "Acme")
  .enable("view cache");
const setApp = await NestFactory.create(ViewsModule, setAdapter, {
  logger: false,
});
await setApp.init();
checkEqual(
  "set() filled the same settings",
  {
    root: setAdapter.views.root,
    defaultEngine: setAdapter.views.defaultEngine,
    cache: setAdapter.views.cache,
  },
  { root: views, defaultEngine: "tpl", cache: true },
);
checkEqual(
  "GET /home renders as it did with the setters",
  await read(await setAdapter.fetch("/home")),
  home,
);
await setApp.close();

await rm(scratch, { recursive: true, force: true });
summary();
