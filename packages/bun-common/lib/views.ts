/**
 * Express's view system — `app.render`, `app.engine`, `app.locals` and the
 * `views` / `view engine` / `view cache` settings — for `res.render`.
 *
 * It follows Express 5's `lib/application.js` (`render`) and `lib/view.js`
 * (`View`) step for step, so a template renders, and fails, exactly as it
 * does there:
 *
 * - a name without an extension takes the default engine's (`"index"` with
 *   `"ejs"` → `index.ejs`); with neither, the lookup throws
 *   `No default engine was specified and no extension was provided.`;
 * - an extension with no registered engine loads the module named after it
 *   and uses its `__express` export, as Express's `require(mod).__express`;
 * - the file is looked up in each `views` directory in turn, as `<name>.<ext>`
 *   then `<name>/index.<ext>`; none found is the error
 *   `Failed to lookup view "<name>" in views directory "<dir>"`, passed to the
 *   callback;
 * - the locals are `app.locals`, then `res.locals`, then the options given;
 * - a callback an engine calls synchronously is deferred to the next tick.
 */
import type { Stats } from "node:fs";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import process from "node:process";

/** What an engine calls back with: an error, or the rendered string. */
export type RenderCallback = (err: Error | null, rendered?: string) => void;

/**
 * A template engine, as Express's `app.engine(ext, fn)` takes it (and as
 * `ejs`, `pug`, `hbs`, … export it as `__express`): renders the file at
 * `path` with `options` (the merged locals) and calls `callback`.
 */
export type ViewEngine = (
  path: string,
  options: Record<string, unknown>,
  callback: RenderCallback,
) => void;

/** The options `render` reads, beyond the template's own locals. */
export interface RenderLocals {
  /** Use (and fill) the view cache for this render; defaults to {@link BunViews.cache}. */
  cache?: boolean;
  /**
   * `res.locals`, merged under the options and over `app.locals` — the slot
   * Express's `res.render` fills. Like Express, the engine's options still
   * carry `_locals` itself, beside the merged locals.
   */
  _locals?: Record<string, unknown>;
  /** Any other local the template reads. */
  [local: string]: unknown;
}

/**
 * Extensions of script files, whose module name is never a view engine: a
 * view with one of these needs its engine registered with `engine()`.
 */
const SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
]);

/** A resolved view: the file to render and the engine that renders it. */
class View {
  /** The view's extension, with its dot (`.ejs`). */
  readonly ext: string;
  /** The engine registered for {@link ext}. */
  readonly engine: ViewEngine;
  /** The absolute path of the template, or `undefined` when none was found. */
  readonly path: string | undefined;

  constructor(
    /** The name as given to `render` (`"index"`, `"users/list.ejs"`). */
    readonly name: string,
    /** The directory, or directories, the name is looked up in. */
    readonly root: string | string[],
    defaultEngine: string | undefined,
    engines: Record<string, ViewEngine>,
    load: (module: string) => unknown,
  ) {
    let ext = extname(name);
    if (!ext && !defaultEngine) {
      throw new Error(
        "No default engine was specified and no extension was provided.",
      );
    }

    let fileName = name;
    if (!ext) {
      ext = defaultEngine!.startsWith(".")
        ? defaultEngine!
        : `.${defaultEngine}`;
      fileName += ext;
    }
    this.ext = ext;

    if (!engines[ext]) {
      const module = ext.slice(1);
      // Express would `require` the module named after the extension. For a
      // script extension that is never a view engine and may be a loader
      // with side effects (`.tsx` loads the `tsx` TypeScript runner), so
      // ask for the engine to be registered instead.
      if (SCRIPT_EXTENSIONS.has(ext)) {
        throw new Error(
          `No view engine registered for "${ext}": register one with engine("${module}", fn).`,
        );
      }
      const fn = (load(module) as { __express?: unknown } | undefined)
        ?.__express;
      if (typeof fn !== "function") {
        throw new TypeError(
          `Module "${module}" does not provide a view engine.`,
        );
      }
      engines[ext] = fn as ViewEngine;
    }
    this.engine = engines[ext];
    this.path = this.#lookup(fileName);
  }

  /** The first `views` directory holding the file, as Express's `View.lookup`. */
  #lookup(fileName: string): string | undefined {
    for (const root of ([] as string[]).concat(this.root)) {
      const loc = resolve(root, fileName);
      const found = this.#resolve(dirname(loc), basename(loc));
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /** `<dir>/<file>`, else `<dir>/<file without ext>/index<ext>`. */
  #resolve(dir: string, file: string): string | undefined {
    const direct = join(dir, file);
    if (statFile(direct)?.isFile()) {
      return direct;
    }
    const index = join(dir, basename(file, this.ext), `index${this.ext}`);
    if (statFile(index)?.isFile()) {
      return index;
    }
    return undefined;
  }

  /** Renders, deferring a callback the engine calls synchronously. */
  render(options: Record<string, unknown>, callback: RenderCallback): void {
    let sync = true;
    this.engine(this.path!, options, (err, rendered) => {
      if (!sync) {
        callback(err, rendered);
        return;
      }
      process.nextTick(() => callback(err, rendered));
    });
    sync = false;
  }
}

/** `fs.statSync`, or `undefined` when the path cannot be read. */
function statFile(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Loads an engine module by name: from the application (the working
 * directory) first, then from this package — so an engine the app installed
 * is found even when this package's own `node_modules` cannot see it (where
 * Express, resolving from itself, would need `app.engine()`).
 */
function loadEngineModule(module: string): unknown {
  try {
    return createRequire(join(process.cwd(), "noop.js"))(module);
  } catch (error) {
    try {
      return createRequire(import.meta.url)(module);
    } catch {
      throw error;
    }
  }
}

/**
 * An application's views, as Express's: where templates live, which engine
 * renders a name without an extension, the registered engines, the
 * application-wide locals and the view cache. `res.render` renders through
 * the instance its response was given (bun-nest's adapter gives every
 * response its own); a response without one renders with a fresh default
 * instance, as an Express app with no view settings would.
 */
export class BunViews {
  /**
   * The directory, or directories in lookup order, templates are found in —
   * Express's `views` setting. Defaults to `views` under the working
   * directory, as Express's does.
   */
  root: string | string[] = resolve("views");

  /**
   * The extension a name without one is given (`"ejs"` or `".ejs"`) —
   * Express's `view engine` setting. Unset by default, so a name without an
   * extension fails to render until one is set.
   */
  defaultEngine: string | undefined = undefined;

  /**
   * Whether resolved views are cached by name — Express's `view cache`
   * setting, on by default only when `NODE_ENV` is `production`. A render's
   * own `cache` local overrides it.
   */
  cache: boolean = process.env.NODE_ENV === "production";

  /** Engines by extension, with the dot (`.ejs`); see {@link engine}. */
  readonly engines: Record<string, ViewEngine> = {};

  /**
   * Locals every render sees, under `res.locals` and the render's own
   * options — Express's `app.locals`. A null-prototype object.
   */
  locals: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;

  /**
   * Express's view settings as engines read them from the locals'
   * `settings`: `views`, `view engine`, `view cache` and `env`, plus
   * `view options` once assigned here. Built on each read from the fields
   * above.
   */
  get settings(): Record<string, unknown> {
    return {
      env: process.env.NODE_ENV || "development",
      views: this.root,
      "view engine": this.defaultEngine,
      "view cache": this.cache,
      ...(this.viewOptions === undefined
        ? {}
        : { "view options": this.viewOptions }),
    };
  }

  /**
   * Options passed to every engine through `settings["view options"]` —
   * Express's `view options` setting, which ejs reads. Unset by default.
   */
  viewOptions: Record<string, unknown> | undefined = undefined;

  /** Resolved views by name, while {@link cache} is on. */
  readonly #cache = new Map<string, View>();

  /**
   * Registers `fn` as the engine for `ext` (`"html"` or `".html"`), as
   * Express's `app.engine`. Throws when `fn` is not a function.
   */
  engine(ext: string, fn: ViewEngine): this {
    if (typeof fn !== "function") {
      throw new TypeError("callback function required");
    }
    this.engines[ext.startsWith(".") ? ext : `.${ext}`] = fn;
    return this;
  }

  /**
   * Renders the view `name` and calls `callback` with the result, as
   * Express's `app.render`: the locals are {@link locals}, then
   * `options._locals` (`res.locals`), then `options`. A failed lookup is
   * passed to the callback; a missing default engine, or an extension whose
   * engine cannot be loaded, throws synchronously, as in Express.
   */
  render(
    name: string,
    options: RenderLocals | RenderCallback | undefined,
    callback?: RenderCallback,
  ): void {
    let opts: RenderLocals = {};
    let done = callback;
    if (typeof options === "function") {
      done = options;
    } else if (options) {
      opts = options;
    }
    const finish: RenderCallback = done ?? (() => undefined);

    const renderOptions: Record<string, unknown> = {
      // Express's `app.locals.settings`: engines read `settings.views` (ejs
      // resolves includes against it) and `settings["view options"]`.
      settings: this.settings,
      ...this.locals,
      ...opts._locals,
      ...opts,
    };
    renderOptions.cache ??= this.cache;
    const useCache = renderOptions.cache === true;

    let view = useCache ? this.#cache.get(name) : undefined;
    if (!view) {
      view = new View(
        name,
        this.root,
        this.defaultEngine,
        this.engines,
        loadEngineModule,
      );
      if (!view.path) {
        const roots = ([] as string[]).concat(view.root);
        const dirs =
          roots.length > 1
            ? `directories "${roots.slice(0, -1).join('", "')}" or "${roots.at(-1)}"`
            : `directory "${roots[0]}"`;
        finish(
          Object.assign(
            new Error(`Failed to lookup view "${name}" in views ${dirs}`),
            { view },
          ),
        );
        return;
      }
      if (useCache) {
        this.#cache.set(name, view);
      }
    }

    try {
      view.render(renderOptions, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
