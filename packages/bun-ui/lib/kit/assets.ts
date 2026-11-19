/**
 * A UI's app bundle, as its server serves it: every file in memory, keyed by
 * its hashed name, with the content type, SRI integrity and ETag worked out
 * once. Shared by every UI of the package (the kit): each UI names itself
 * (`"jobs"`, `"docs"`), which picks its entry (`app/<ui>/main.tsx`) and its
 * dist directory (`dist/<ui>/`), and passes the error its options throw.
 *
 * Two sources, one shape. A published package ships `dist/<ui>/` (built on
 * `prepack` by `scripts/build.ts`): `manifest.json` plus the hashed files
 * under `assets/`. Inside the repo `dist/` is usually absent, so the same
 * {@link buildAssets} runs in memory on the first request instead, once per
 * entry, and logs one line saying so.
 *
 * It imports no domain package: an error for a bad configuration is made by
 * the caller's {@link AssetsFail}, so the kit never makes an entry need a peer.
 *
 * A UI's bundle also carries its **mount stylesheet** (embedding.md §4): the
 * entry stylesheet scoped to the mount element (`./scopeCss.ts`), made from
 * the very stylesheet the page links, so the two never drift. The page never
 * links it; `/assets/:file` serves it like any other file.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { scopeStylesheet } from "./scopeCss";

/** The package root (`packages/bun-ui`, or `node_modules/@kingsleyweb/bun-ui`). */
export const PACKAGE_DIR = resolve(import.meta.dir, "..", "..");

/** A UI's React app entry point, `app/<ui>/main.tsx`, bundled by {@link buildAssets}. */
export function uiEntry(ui: string): string {
  return join(PACKAGE_DIR, "app", ui, "main.tsx");
}

/**
 * A UI's mount entry, `app/<ui>/mount.tsx` (embedding.md §3): the module a
 * host page imports to mount the UI in its own layout, bundled beside the
 * page's by {@link buildAssets}.
 */
export function uiMountEntry(ui: string): string {
  return join(PACKAGE_DIR, "app", ui, "mount.tsx");
}

/** The mount entry beside a UI's page entry (`mount.tsx` next to `main.tsx`), when there is one. */
export function siblingMountEntry(entry: string): string | undefined {
  const mount = join(dirname(entry), "mount.tsx");
  return existsSync(mount) ? mount : undefined;
}

/** Where `scripts/build.ts` writes a UI's bundle and where its server looks for it: `dist/<ui>`. */
export function uiDistDir(ui: string): string {
  return join(PACKAGE_DIR, "dist", ui);
}

/**
 * Makes the error this module throws for a bad configuration (a missing
 * entry, a corrupt `dist/`, `dev: false` with no build). It imports no domain
 * package: each UI passes its own domain's `ConfigError` (`jobsUi()` passes
 * bun-jobs', `docsUi()` bun-common's), so the bundle code never makes an
 * entry need a peer.
 */
export type AssetsFail = (
  message: string,
  context: Record<string, unknown>,
) => Error;

/** The {@link AssetsFail} used when a caller passes none: a plain `Error`. */
export const plainFail: AssetsFail = (message) => new Error(message);

/** The manifest's file name inside a dist directory. */
export const MANIFEST_FILE = "manifest.json";

/** The sub-directory of a dist directory holding the hashed files. */
export const ASSETS_DIR = "assets";

/** The unhashed copy of a UI's mount stylesheet in its dist directory (`dist/<ui>/mount.css`), for `exports["./<ui>/mount.css"]`. */
export const MOUNT_STYLESHEET = "mount.css";

/** The directory of a UI's mount entry point in its dist directory (`dist/<ui>/mount/index.js`), for `exports["./<ui>/mount"]`. */
export const MOUNT_MODULE_DIR = "mount";

/** Options of {@link writeMountExports}. */
export interface WriteMountExportsOptions {
  /**
   * Write the mount module's files into `<dir>/assets/` too, for a dist
   * directory {@link writeAssets} did not write (`scripts/build.ts --exports`,
   * which `build:types` runs). Defaults to `false`: the full build's
   * `assets/` holds them already.
   */
  moduleFiles?: boolean;
}

/**
 * Writes what a UI's `exports` name in its dist directory (embedding.md
 * §3): `mount.css`, the scoped stylesheet, and `mount/index.js`,
 * re-exporting the hashed module in `assets/` (`export * from
 * "../assets/mount-<hash>.js"`), so the tarball carries the module once and
 * a host's bundler follows it there. No manifest is written: a server never
 * mistakes these for a build. Throws for a bundle built without a mount
 * entry.
 */
export async function writeMountExports(
  assets: UiAssets,
  dir: string,
  options: WriteMountExportsOptions = {},
): Promise<void> {
  const css = assets.mount?.css[0];
  const js = assets.mount?.js;
  if (css === undefined || js === undefined) {
    throw new Error("bun-ui: the bundle has no mount module or stylesheet");
  }
  await Bun.write(join(dir, MOUNT_STYLESHEET), assets.files.get(css)!.body);
  if (options.moduleFiles === true) {
    mkdirSync(join(dir, ASSETS_DIR), { recursive: true });
    for (const name of assets.mount!.files ?? []) {
      await Bun.write(
        join(dir, ASSETS_DIR, name),
        assets.files.get(name)!.body,
      );
    }
  }
  const moduleDir = join(dir, MOUNT_MODULE_DIR);
  rmSync(moduleDir, { recursive: true, force: true });
  mkdirSync(moduleDir, { recursive: true });
  await Bun.write(
    join(moduleDir, "index.js"),
    `export * from "../${ASSETS_DIR}/${js}";\n`,
  );
}

/** One file of the bundle, as `dist/manifest.json` records it. */
export interface UiManifestFile {
  /** The `Content-Type` it is served with, e.g. `"text/javascript; charset=utf-8"`. */
  type: string;
  /** Its size in bytes. */
  size: number;
  /** Its Subresource Integrity digest, `"sha384-<base64>"`. */
  integrity: string;
}

/** `dist/manifest.json`: what the build produced, and which files the shell links. */
export interface UiManifest {
  /** Shape version of the manifest. Currently `1`. */
  version: 1;
  /** The files the HTML shell references directly. */
  entry: {
    /** File name of the entry module (loaded with `<script type="module">`). */
    js: string;
    /** File names of every stylesheet the build emitted, in build order. */
    css: string[];
  };
  /** Every file under `dist/assets/`, by file name. */
  files: Record<string, UiManifestFile>;
  /**
   * The mount stylesheets (embedding.md §4), the ones a host links beside
   * the mounted UI; absent from a bundle built without
   * {@link BuildAssetsOptions.mount}.
   */
  mount?: {
    /** The UI they are scoped to (`"jobs"`): the mount root's `data-bun-ui`. */
    ui: string;
    /** File names of the scoped stylesheets, in the order to link them: the entry's, then any the server adds (a custom theme's). */
    css: string[];
    /**
     * File name of the mount module (`app/<ui>/mount.tsx` bundled:
     * `mount-<hash>.js`, its chunks beside it), or absent for a bundle
     * built without a mount entry ({@link BuildAssetsOptions.mountEntry}).
     */
    js?: string;
    /** Every file of the mount module: {@link js}, its chunks and their source maps (absent without {@link js}). */
    files?: string[];
  };
}

/** One file of the bundle, held in memory. */
export interface UiAsset extends UiManifestFile {
  /** The hashed file name, e.g. `"main-3kx9a2f1.js"`. It is also the URL segment. */
  name: string;
  /** The bytes served. */
  body: Uint8Array<ArrayBuffer>;
  /** A strong ETag derived from the integrity digest, quoted. */
  etag: string;
}

/** The whole bundle, ready to serve. */
export interface UiAssets {
  /** The files the shell links: the entry module and the stylesheets. */
  entry: UiManifest["entry"];
  /** Every file, by its hashed name. */
  files: ReadonlyMap<string, UiAsset>;
  /** The mount stylesheets, when the bundle was built with them ({@link BuildAssetsOptions.mount}). */
  mount?: UiManifest["mount"];
  /** Where the bundle came from: a `dist/` directory or an in-memory build. */
  source: "dist" | "memory";
}

/** Options for {@link buildAssets}. */
export interface BuildAssetsOptions {
  /** The entry point to bundle: a UI's {@link uiEntry}, or a test's fixture. */
  entry: string;
  /** Minify the output. Defaults to `true`. */
  minify?: boolean;
  /**
   * Source maps: `"linked"` (default) emits `.map` files the bundle points
   * at, `"external"` emits them unreferenced, `"none"` emits none.
   */
  sourcemap?: "linked" | "external" | "none";
  /**
   * Type-check the entry and everything it imports first, with Bun.build's
   * `check` (Bun ≥ 1.4.3; app/tsconfig.json's options), and fail the build on
   * a type error. Defaults to `false`: `scripts/build.ts` (prepack) turns it
   * on; the in-memory build a UI's server runs on a request never does, which
   * also keeps it off a 1.4.2 runtime. Adds about 175 ms.
   */
  check?: boolean;
  /** Makes the error for a missing entry. Defaults to {@link plainFail}. */
  fail?: AssetsFail;
  /**
   * The UI's name (`"jobs"`): also emit the entry stylesheet scoped to that
   * UI's mount element, as `mount-<hash>.css` ({@link UiAssets.mount}).
   * Defaults to none (a test fixture's bundle).
   */
  mount?: string;
  /**
   * The UI's mount entry (`app/<ui>/mount.tsx`, {@link uiMountEntry}):
   * bundled too, its module and chunks added to the files and named in
   * {@link UiAssets.mount}'s `js`. Needs {@link mount}. Defaults to none.
   */
  mountEntry?: string;
}

/** Content types by extension, so both sources agree whatever Bun reports. */
const CONTENT_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  map: "application/json; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
};

/** A served file name: one segment, no dot segments, nothing a URL must escape. */
const FILE_NAME = /^[\w.~-]+$/;

/** The `Content-Type` for a file name, falling back to what the bundler reported. */
export function contentTypeFor(name: string, reported?: string): string {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return (
    CONTENT_TYPES[extension] ??
    reported?.replace(/;\s*/, "; ") ??
    "application/octet-stream"
  );
}

/** The SRI digest of some bytes, `"sha384-<base64>"`. */
export function integrityOf(bytes: Uint8Array): string {
  return `sha384-${new Bun.CryptoHasher("sha384").update(bytes).digest("base64")}`;
}

/** Wraps bytes as a served asset. */
function toAsset(
  name: string,
  body: Uint8Array<ArrayBuffer>,
  type: string,
): UiAsset {
  const integrity = integrityOf(body);
  return {
    name,
    body,
    type,
    size: body.byteLength,
    integrity,
    // The digest already identifies the bytes; the prefix and padding are noise.
    etag: `"${integrity.slice("sha384-".length, "sha384-".length + 32)}"`,
  };
}

/**
 * Bundles the app with `Bun.build`, in memory: browser target, content-hashed
 * names (`[name]-[hash].[ext]`), code splitting, `NODE_ENV=production`.
 * Throws with the bundler's messages when the build fails.
 */
export async function buildAssets(
  options: BuildAssetsOptions,
): Promise<UiAssets> {
  const { entry } = options;
  if (!existsSync(entry)) {
    throw (options.fail ?? plainFail)(
      `bun-ui: the app entry ${entry} does not exist`,
      { entry },
    );
  }
  const page = await bundle(entry, options);
  const stylesheets = entryStylesheets(page.js, page.css);
  let assets: UiAssets = {
    entry: { js: page.js, css: stylesheets },
    files: page.files,
    source: "memory",
  };
  if (options.mount === undefined) return assets;
  assets = withMountStylesheet(assets, options.mount, stylesheets);
  if (options.mountEntry === undefined) return assets;
  const mount = await bundle(options.mountEntry, options);
  const files = new Map(assets.files);
  const own: string[] = [];
  // Its stylesheet is the page's rules unscoped: the scoped one stands for it.
  for (const [name, file] of mount.files) {
    if (!name.endsWith(".css") && !name.endsWith(".css.map")) {
      files.set(name, file);
      own.push(name);
    }
  }
  return {
    ...assets,
    files,
    mount: { ...assets.mount!, js: mount.js, files: own.sort() },
  };
}

/** One entry bundled, as {@link buildAssets} bundles it: its files, its module and its stylesheets. */
async function bundle(
  entry: string,
  options: BuildAssetsOptions,
): Promise<{ files: Map<string, UiAsset>; js: string; css: string[] }> {
  const sourcemap = options.sourcemap ?? "linked";
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: options.minify ?? true,
    splitting: true,
    sourcemap,
    naming: {
      entry: "[name]-[hash].[ext]",
      chunk: "[name]-[hash].[ext]",
      asset: "[name]-[hash].[ext]",
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    throw: false,
    // Spread rather than written out: `@types/bun` 1.4.2 pins bun-types
    // 1.4.2, whose `BuildConfig` predates `check`. Write `check` directly
    // once `@types/bun` 1.4.3 is the floor.
    ...(options.check === true ? { check: true } : {}),
  });
  if (!result.success) {
    // A type error from `check` is "TS2322: …" alone; its position says where.
    const messages = result.logs.map((log) =>
      log.position === null
        ? log.message
        : `${log.position.file}:${log.position.line}:${log.position.column}: ${log.message}`,
    );
    throw new Error(
      `bun-ui: building ${entry} failed:\n${messages.join("\n")}`,
    );
  }

  const files = new Map<string, UiAsset>();
  let js: string | undefined;
  const css: string[] = [];
  for (const output of result.outputs) {
    const name = basename(output.path);
    const body = new Uint8Array(await output.arrayBuffer());
    files.set(name, toAsset(name, body, contentTypeFor(name, output.type)));
    if (output.kind === "entry-point" && name.endsWith(".js")) {
      js = name;
    } else if (name.endsWith(".css")) {
      css.push(name);
    }
  }
  if (js === undefined) {
    throw new Error(`bun-ui: building ${entry} produced no entry module`);
  }
  return { files, js, css };
}

/** A file's hashed name, `<stem>-<hash>.css`, after its content. */
function hashedName(stem: string, body: Uint8Array): string {
  const hash = new Bun.CryptoHasher("sha256")
    .update(body)
    .digest("hex")
    .slice(0, 12);
  return `${stem}-${hash}.css`;
}

/** The text of the bundle's stylesheets `names`, in order. */
function stylesheetText(assets: UiAssets, names: readonly string[]): string {
  const decoder = new TextDecoder();
  return names
    .map((name) => decoder.decode(assets.files.get(name)!.body))
    .join("\n");
}

/** The bundle with the entry stylesheets `names` scoped for mounting as `mount-<hash>.css`. */
function withMountStylesheet(
  assets: UiAssets,
  ui: string,
  names: readonly string[],
): UiAssets {
  const body = new TextEncoder().encode(
    scopeStylesheet(stylesheetText(assets, names), ui),
  ) as Uint8Array<ArrayBuffer>;
  const name = hashedName("mount", body);
  const files = new Map(assets.files);
  files.set(name, toAsset(name, body, CONTENT_TYPES.css));
  return { ...assets, files, mount: { ui, css: [name] } };
}

/**
 * The bundle with one more stylesheet, linked after the built-in ones: a
 * custom theme's (`./theme`), named `<stem>-<hash>.css` after its content so
 * it caches like the rest, with its own SRI and ETag. A bundle with mount
 * stylesheets gets its scoped copy too (`<stem>-mount-<hash>.css`), after
 * theirs. The bundle is not changed; a new one is returned.
 *
 * @param assets The loaded bundle.
 * @param stem The file's name before the hash (`"theme"`).
 * @param css The stylesheet's text.
 */
export function withStylesheet(
  assets: UiAssets,
  stem: string,
  css: string,
): UiAssets {
  const body = new TextEncoder().encode(css) as Uint8Array<ArrayBuffer>;
  const name = hashedName(stem, body);
  const files = new Map(assets.files);
  files.set(name, toAsset(name, body, CONTENT_TYPES.css));
  let mount = assets.mount;
  if (mount !== undefined) {
    const scoped = new TextEncoder().encode(
      scopeStylesheet(css, mount.ui),
    ) as Uint8Array<ArrayBuffer>;
    const scopedName = hashedName(`${stem}-mount`, scoped);
    files.set(scopedName, toAsset(scopedName, scoped, CONTENT_TYPES.css));
    mount = { ...mount, css: [...mount.css, scopedName] };
  }
  return {
    ...assets,
    entry: { js: assets.entry.js, css: [...assets.entry.css, name] },
    files,
    ...(mount === undefined ? {} : { mount }),
  };
}

/** A hashed file name without its hash and extension: `main-3kx9.css` → `main`. */
function stemOf(name: string): string {
  return name.replace(/-[a-z0-9]+\.[a-z]+$/, "");
}

/**
 * The stylesheets the shell links. With code splitting, Bun emits the entry's
 * stylesheet holding every rule, lazily imported ones included, plus one per
 * split chunk repeating that chunk's rules, and marks them all "asset". The
 * entry's is the one named after the entry module; linking the others too
 * would download the same rules twice. If none matches (a bundler change),
 * every stylesheet is linked, which is redundant but never unstyled.
 */
export function entryStylesheets(js: string, css: readonly string[]): string[] {
  const own = css.filter((name) => stemOf(name) === stemOf(js));
  return own.length > 0 ? own : [...css];
}

/** The manifest describing a bundle. */
export function manifestOf(assets: UiAssets): UiManifest {
  const files: Record<string, UiManifestFile> = {};
  for (const [name, file] of assets.files) {
    files[name] = {
      type: file.type,
      size: file.size,
      integrity: file.integrity,
    };
  }
  return {
    version: 1,
    entry: { js: assets.entry.js, css: [...assets.entry.css] },
    files,
    ...(assets.mount === undefined
      ? {}
      : {
          mount: {
            ...assets.mount,
            css: [...assets.mount.css],
            ...(assets.mount.files === undefined
              ? {}
              : { files: [...assets.mount.files] }),
          },
        }),
  };
}

/**
 * Writes a bundle as a dist directory: the files under `<dir>/assets/` (the
 * directory is emptied first, so stale hashes do not accumulate) and
 * `<dir>/manifest.json`. Returns the manifest written.
 */
export async function writeAssets(
  assets: UiAssets,
  dir: string,
): Promise<UiManifest> {
  const assetsDir = join(dir, ASSETS_DIR);
  rmSync(assetsDir, { recursive: true, force: true });
  mkdirSync(assetsDir, { recursive: true });
  for (const [name, file] of assets.files) {
    await Bun.write(join(assetsDir, name), file.body);
  }
  const manifest = manifestOf(assets);
  await Bun.write(
    join(dir, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

/** Whether `dir` holds a built bundle (its manifest exists). */
export function hasDist(dir: string): boolean {
  return existsSync(join(dir, MANIFEST_FILE));
}

/** A string property of an unknown value, or `undefined`. */
function stringField(value: unknown, key: string): string | undefined {
  const field =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  return typeof field === "string" ? field : undefined;
}

/**
 * Reads a dist directory into memory, synchronously. Every file the manifest
 * lists must exist and match its recorded integrity — a half-copied or
 * hand-edited dist fails here, with the file named, rather than as a browser
 * refusing a script over SRI.
 */
export function loadDistAssets(
  dir: string,
  fail: AssetsFail = plainFail,
): UiAssets {
  const manifestPath = join(dir, MANIFEST_FILE);
  const corrupt = (why: string): Error =>
    fail(
      `bun-ui: ${manifestPath} is not a usable build (${why}); rebuild it with \`bun scripts/build.ts\``,
      { dir },
    );
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw corrupt(error instanceof Error ? error.message : String(error));
  }
  const record = manifest as Partial<UiManifest> | null;
  if (
    typeof record !== "object" ||
    record === null ||
    record.version !== 1 ||
    typeof record.files !== "object" ||
    record.files === null
  ) {
    throw corrupt("unknown manifest version or shape");
  }
  const js = stringField(record.entry, "js");
  const cssList = (record.entry as { css?: unknown } | undefined)?.css;
  if (
    js === undefined ||
    !Array.isArray(cssList) ||
    !cssList.every((name) => typeof name === "string")
  ) {
    throw corrupt("no entry");
  }

  const files = new Map<string, UiAsset>();
  for (const [name, info] of Object.entries(record.files)) {
    if (!FILE_NAME.test(name) || name === "." || name === "..") {
      throw corrupt(`bad file name ${JSON.stringify(name)}`);
    }
    let body: Uint8Array<ArrayBuffer>;
    try {
      body = new Uint8Array(readFileSync(join(dir, ASSETS_DIR, name)));
    } catch {
      throw corrupt(`${name} is missing`);
    }
    const asset = toAsset(
      name,
      body,
      stringField(info, "type") ?? contentTypeFor(name),
    );
    if (asset.integrity !== stringField(info, "integrity")) {
      throw corrupt(`${name} does not match its recorded integrity`);
    }
    files.set(name, asset);
  }
  for (const name of [js, ...cssList]) {
    if (!files.has(name)) {
      throw corrupt(`the entry file ${name} is not in the manifest`);
    }
  }
  let mount: UiManifest["mount"];
  if (record.mount !== undefined) {
    const ui = stringField(record.mount, "ui");
    const mountCss = (record.mount as { css?: unknown } | null)?.css;
    if (
      ui === undefined ||
      !Array.isArray(mountCss) ||
      !mountCss.every(
        (name): name is string => typeof name === "string" && files.has(name),
      )
    ) {
      throw corrupt("a bad mount entry");
    }
    const { js: mountJs, files: mountFiles } = record.mount as {
      js?: unknown;
      files?: unknown;
    };
    if (
      (mountJs === undefined) !== (mountFiles === undefined) ||
      (mountJs !== undefined &&
        (typeof mountJs !== "string" ||
          !Array.isArray(mountFiles) ||
          !mountFiles.includes(mountJs) ||
          !mountFiles.every(
            (name): name is string =>
              typeof name === "string" && files.has(name),
          )))
    ) {
      throw corrupt("a bad mount entry");
    }
    mount = {
      ui,
      css: mountCss,
      ...(typeof mountJs === "string"
        ? { js: mountJs, files: mountFiles as string[] }
        : {}),
    };
  }
  return {
    entry: { js, css: cssList },
    files,
    ...(mount === undefined ? {} : { mount }),
    source: "dist",
  };
}

/** In-memory builds, by entry path: each entry is built at most once per process. */
const memoryBuilds = new Map<string, Promise<UiAssets>>();

/**
 * Builds an entry in memory, once per process: concurrent and later callers
 * share the first build. A failed build is forgotten, so the next call tries
 * again. Logs one `info` line when a build starts, naming the UI's
 * `dist/<ui>` that was not there.
 */
export function buildAssetsOnce(
  entry: string,
  logger: Logger,
  ui: string,
): Promise<UiAssets> {
  const key = resolve(entry);
  let build = memoryBuilds.get(key);
  if (build === undefined) {
    logger.info(
      `bun-ui: no dist/${ui} build, bundling the app in memory (run \`bun scripts/build.ts\` to prebuild)`,
      { entry: key },
    );
    build = buildAssets({
      entry: key,
      mount: ui,
      mountEntry: siblingMountEntry(key),
    });
    memoryBuilds.set(key, build);
    build.catch(() => {
      if (memoryBuilds.get(key) === build) {
        memoryBuilds.delete(key);
      }
    });
  }
  return build;
}

/** Where a UI's server gets its bundle from, and how. */
export interface AssetSourceOptions {
  /** The UI's name (`"jobs"`, `"docs"`), as in `dist/<ui>`: the in-memory build's notice names it. */
  ui: string;
  /** `false`: require `distDir`; `true`: always build `entry` in memory; `undefined`: dist when present, else build. */
  dev: boolean | undefined;
  /** The dist directory to read. */
  distDir: string;
  /** The entry to build in memory. */
  entry: string;
  /** Receives the one-line notice of an in-memory build. */
  logger: Logger;
  /** Makes the error for `dev: false` with no build, or a corrupt one: the UI's domain `ConfigError`. */
  fail: AssetsFail;
}

/**
 * Resolves the bundle source when a UI's server function (`jobsUi()`,
 * `docsUi()`) is called. A dist directory is
 * read synchronously right away, so a missing or corrupt one fails the call,
 * not the first request; an in-memory build is deferred to the first request.
 *
 * @throws `options.fail`'s error with `dev: false` and no dist, or a corrupt dist.
 */
export function resolveAssetSource(
  options: AssetSourceOptions,
): () => Promise<UiAssets> {
  const { dev, distDir, entry, logger, fail, ui } = options;
  if (dev !== true && hasDist(distDir)) {
    const assets = Promise.resolve(loadDistAssets(distDir, fail));
    return () => assets;
  }
  if (dev === false) {
    throw fail(
      `bun-ui: no build found at ${join(distDir, MANIFEST_FILE)} and \`dev: false\` forbids building in memory; run \`bun scripts/build.ts\` in the package, or leave \`dev\` unset`,
      { distDir },
    );
  }
  return () => buildAssetsOnce(entry, logger, ui);
}
