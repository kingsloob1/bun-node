/**
 * The app bundle, as the server serves it: every file in memory, keyed by its
 * hashed name, with the content type, SRI integrity and ETag worked out once.
 *
 * Two sources, one shape. A published package ships `dist/` (built on
 * `prepack` by `scripts/build.ts`): `dist/manifest.json` plus the hashed files
 * under `dist/assets/`. Inside the repo `dist/` is usually absent, so the same
 * {@link buildAssets} runs in memory on the first request instead, once per
 * entry, and logs one line saying so.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ConfigError } from "@kingsleyweb/bun-jobs";

/** The package root (`packages/bun-jobs-ui`, or `node_modules/@kingsleyweb/bun-jobs-ui`). */
export const PACKAGE_DIR = resolve(import.meta.dir, "..");

/** The React app's entry point, bundled by {@link buildAssets}. */
export const DEFAULT_ENTRY = join(PACKAGE_DIR, "app", "main.tsx");

/** Where `scripts/build.ts` writes the bundle and where `jobsUi()` looks for it. */
export const DEFAULT_DIST_DIR = join(PACKAGE_DIR, "dist");

/** The manifest's file name inside a dist directory. */
export const MANIFEST_FILE = "manifest.json";

/** The sub-directory of a dist directory holding the hashed files. */
export const ASSETS_DIR = "assets";

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
  /** Where the bundle came from: a `dist/` directory or an in-memory build. */
  source: "dist" | "memory";
}

/** Options for {@link buildAssets}. */
export interface BuildAssetsOptions {
  /** The entry point to bundle. Defaults to {@link DEFAULT_ENTRY}, the React app. */
  entry?: string;
  /** Minify the output. Defaults to `true`. */
  minify?: boolean;
  /**
   * Source maps: `"linked"` (default) emits `.map` files the bundle points
   * at, `"external"` emits them unreferenced, `"none"` emits none.
   */
  sourcemap?: "linked" | "external" | "none";
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
  options: BuildAssetsOptions = {},
): Promise<UiAssets> {
  const entry = options.entry ?? DEFAULT_ENTRY;
  if (!existsSync(entry)) {
    throw new ConfigError(
      `bun-jobs-ui: the app entry ${entry} does not exist`,
      {
        entry,
      },
    );
  }
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
  });
  if (!result.success) {
    const messages = result.logs.map((log) => log.message);
    throw new Error(
      `bun-jobs-ui: building ${entry} failed:\n${messages.join("\n")}`,
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
    throw new Error(`bun-jobs-ui: building ${entry} produced no entry module`);
  }
  return {
    entry: { js, css: entryStylesheets(js, css) },
    files,
    source: "memory",
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
  };
}

/**
 * Writes a bundle as a dist directory: the files under `<dir>/assets/` (the
 * directory is emptied first, so stale hashes do not accumulate) and
 * `<dir>/manifest.json`. Returns the manifest written.
 */
export async function writeAssets(
  assets: UiAssets,
  dir: string = DEFAULT_DIST_DIR,
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
export function hasDist(dir: string = DEFAULT_DIST_DIR): boolean {
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
export function loadDistAssets(dir: string = DEFAULT_DIST_DIR): UiAssets {
  const manifestPath = join(dir, MANIFEST_FILE);
  const corrupt = (why: string): ConfigError =>
    new ConfigError(
      `bun-jobs-ui: ${manifestPath} is not a usable build (${why}); rebuild it with \`bun scripts/build.ts\``,
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
  for (const name of [js, ...(cssList as string[])]) {
    if (!files.has(name)) {
      throw corrupt(`the entry file ${name} is not in the manifest`);
    }
  }
  return { entry: { js, css: cssList as string[] }, files, source: "dist" };
}

/** In-memory builds, by entry path: each entry is built at most once per process. */
const memoryBuilds = new Map<string, Promise<UiAssets>>();

/**
 * Builds an entry in memory, once per process: concurrent and later callers
 * share the first build. A failed build is forgotten, so the next call tries
 * again. Logs one `info` line when a build starts.
 */
export function buildAssetsOnce(
  entry: string,
  logger: Logger,
): Promise<UiAssets> {
  const key = resolve(entry);
  let build = memoryBuilds.get(key);
  if (build === undefined) {
    logger.info(
      "bun-jobs-ui: no dist/ build, bundling the app in memory (run `bun scripts/build.ts` to prebuild)",
      { entry: key },
    );
    build = buildAssets({ entry: key });
    memoryBuilds.set(key, build);
    build.catch(() => {
      if (memoryBuilds.get(key) === build) {
        memoryBuilds.delete(key);
      }
    });
  }
  return build;
}

/** Where `jobsUi()` gets its bundle from, and how. */
export interface AssetSourceOptions {
  /** `false`: require `distDir`; `true`: always build `entry` in memory; `undefined`: dist when present, else build. */
  dev: boolean | undefined;
  /** The dist directory to read. */
  distDir: string;
  /** The entry to build in memory. */
  entry: string;
  /** Receives the one-line notice of an in-memory build. */
  logger: Logger;
}

/**
 * Resolves the bundle source when `jobsUi()` is called. A dist directory is
 * read synchronously right away, so a missing or corrupt one fails the call,
 * not the first request; an in-memory build is deferred to the first request.
 *
 * @throws ConfigError with `dev: false` and no dist, or a corrupt dist.
 */
export function resolveAssetSource(
  options: AssetSourceOptions,
): () => Promise<UiAssets> {
  const { dev, distDir, entry, logger } = options;
  if (dev !== true && hasDist(distDir)) {
    const assets = Promise.resolve(loadDistAssets(distDir));
    return () => assets;
  }
  if (dev === false) {
    throw new ConfigError(
      `bun-jobs-ui: no build found at ${join(distDir, MANIFEST_FILE)} and \`dev: false\` forbids building in memory; run \`bun scripts/build.ts\` in the package, or leave \`dev\` unset`,
      { distDir },
    );
  }
  return () => buildAssetsOnce(entry, logger);
}
