/**
 * Option tour: every `ServeStaticOptions` field of `createServeStaticHandler`,
 * each asserted.
 *
 * ```bash
 * bun 12-options/static-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - Files are written to a fresh directory under `os.tmpdir()`, so sizes and
 *   modification times are known; it is removed at the end.
 * - `fallthrough` defaults to `true`, as in `serve-static`: a client error —
 *   a missing file or ignored dotfile (404), a denied dotfile or traversal
 *   (403) — calls `next()`, and so does a method other than GET/HEAD. With
 *   `fallthrough: false` the error goes to `next(err)` (a `ServeStaticError`),
 *   and another method is a `405`. The router here has a later route
 *   answering `299` and an error handler answering the forwarded status.
 * - A directory without its trailing slash is a `301` to the slashed path
 *   (`redirect`, default `true`), or a miss with `redirect: false` — as in
 *   `serve-static`.
 * - `setHeaders` receives the file's `fs.Stats`.
 * - `maxAge` is milliseconds, or an `ms`-style string (`"90s"`, `"1.5h"`,
 *   `"1d"`); anything unparseable means no `Cache-Control`.
 * - Range requests need `Bun.serve`, so that section binds port 0.
 * - `precompressed` and `compression` are asserted against `.br`/`.gz`/`.zst`
 *   siblings generated in a directory of their own.
 */
import type {
  RouterErrorMiddlewareHandler,
  ServeStaticOptions,
} from "@kingsleyweb/bun-common";
import type { Stats } from "node:fs";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brotliCompressSync,
  gunzipSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import {
  BunHttpAdapter,
  BunRouter,
  createServeStaticHandler,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title } from "../shared/console";

title("Option tour: ServeStaticOptions");

const root = await mkdtemp(join(tmpdir(), "bun-common-static-tour-"));
await mkdir(join(root, "docs"), { recursive: true });
await mkdir(join(root, "guide"), { recursive: true });
await mkdir(join(root, ".well-known"), { recursive: true });
await writeFile(join(root, "index.html"), "<h1>home</h1>");
await writeFile(join(root, "about.html"), "about");
await writeFile(join(root, "about.htm"), "about (htm)");
await writeFile(join(root, "notes.txt"), "abcdefghijklmnopqrstuvwxyz");
await writeFile(join(root, "docs", "start.htm"), "start");
await writeFile(join(root, "guide", "index.html"), "guide");
await writeFile(join(root, ".env"), "SECRET=1");
await writeFile(join(root, ".well-known", "security.txt"), "contact");

/**
 * A router serving `root` under `/static` with `options` (on every method,
 * as `use` would mount serve-static), a fallback route answering `299`, and an
 * error handler answering a forwarded error's status with its `name`.
 */
function site(options: ServeStaticOptions = {}, dir: string = root): BunRouter {
  const router = new BunRouter();
  const { prefix, handler } = createServeStaticHandler(dir, {
    prefix: "/static",
    ...options,
  });
  router.all(`${prefix}/*`, handler);
  router.all("/static/*", (_req, res) => {
    res.status(299).send("next route");
  });
  router.use(((err, _req, res, _next) => {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).send((err as Error).name);
  }) satisfies RouterErrorMiddlewareHandler);
  return router;
}

/** Status and text of `GET path` on a router built with `options`. */
async function get(
  options: ServeStaticOptions,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await site(options).fetch(path, { headers });
  return {
    status: response.status,
    text: await response.text(),
    headers: response.headers,
  };
}

/** The weak ETag the handler builds for a file: size and mtime in hex. */
function expectedEtag(path: string): string {
  const file = Bun.file(path);
  return `W/"${file.size.toString(16)}-${Math.floor(file.lastModified).toString(16)}"`;
}

/* ------------------------------------------------------------------ */
step("Response headers for a file");

const about = await get({}, "/static/about.html");
checkEqual(
  "200 with the file's bytes",
  [about.status, about.text],
  [200, "about"],
);
check(
  "Content-Type from the extension",
  (about.headers.get("content-type") ?? "").startsWith("text/html"),
  about.headers.get("content-type"),
);
checkEqual("Content-Length", about.headers.get("content-length"), "5");
checkEqual("Accept-Ranges", about.headers.get("accept-ranges"), "bytes");

/* ------------------------------------------------------------------ */
step("prefix");

checkEqual(
  "the handler reports the prefix, without a trailing slash",
  createServeStaticHandler(root, { prefix: "/assets/" }).prefix,
  "/assets",
);
checkEqual("no prefix is ''", createServeStaticHandler(root).prefix, "");
const unprefixed = new BunRouter();
const bareHandler = createServeStaticHandler(root);
unprefixed.get(`${bareHandler.prefix}/*`, bareHandler.handler);
checkEqual(
  "with no prefix, the URL path is the file path",
  await (await unprefixed.fetch("/notes.txt")).text(),
  "abcdefghijklmnopqrstuvwxyz",
);

/* ------------------------------------------------------------------ */
step("fallthrough");

checkEqual(
  "true (default): a miss goes to the next route",
  (await get({}, "/static/missing.txt")).status,
  299,
);
const missing = await get({ fallthrough: false }, "/static/missing.txt");
checkEqual(
  "false: a miss is next(err) with a 404 NotFoundError",
  [missing.status, missing.text],
  [404, "NotFoundError"],
);
checkEqual(
  "true: an encoded traversal falls through like any other",
  (await get({}, "/static/..%2fsecret")).status,
  299,
);
const traversal = await get(
  { fallthrough: false },
  "/static/..%2f..%2fetc%2fpasswd",
);
checkEqual(
  "false: an encoded traversal is send's 403 ForbiddenError",
  [traversal.status, traversal.text],
  [403, "ForbiddenError"],
);
const posted = await site({}).fetch("/static/notes.txt", { method: "POST" });
checkEqual("true: a POST goes to the next route", posted.status, 299);
const refused = await site({ fallthrough: false }).fetch("/static/notes.txt", {
  method: "POST",
});
checkEqual(
  "false: a POST is 405 with Allow: GET, HEAD and no body",
  [refused.status, refused.headers.get("allow"), await refused.text()],
  [405, "GET, HEAD", ""],
);
// The router refuses a param it cannot decode before the handler runs, as
// Express 5 does: a `URIError` with `status: 400` enters the pipeline, where
// this router's error handler answers it.
const malformed = await get({}, "/static/%E0%A4%A");
checkEqual(
  "a malformed escape is Express 5's 400 URIError",
  [malformed.status, malformed.text],
  [400, "URIError"],
);

/* ------------------------------------------------------------------ */
step("dotfiles");

checkEqual(
  "'ignore' (default): a miss, so next()",
  (await get({}, "/static/.env")).status,
  299,
);
checkEqual(
  "'ignore' with fallthrough: false — a 404 error",
  (await get({ fallthrough: false }, "/static/.env")).status,
  404,
);
const denied = await get(
  { dotfiles: "deny", fallthrough: false },
  "/static/.env",
);
checkEqual(
  "'deny' with fallthrough: false — a 403 ForbiddenError",
  [denied.status, denied.text],
  [403, "ForbiddenError"],
);
checkEqual(
  "'deny' falls through by default, as serve-static's 403/next()",
  (await get({ dotfiles: "deny" }, "/static/.env")).status,
  299,
);
checkEqual(
  "'allow': served",
  (await get({ dotfiles: "allow" }, "/static/.env")).text,
  "SECRET=1",
);
checkEqual(
  "a dot directory anywhere in the path counts",
  [
    (
      await get(
        { dotfiles: "deny", fallthrough: false },
        "/static/.well-known/security.txt",
      )
    ).status,
    (await get({ dotfiles: "allow" }, "/static/.well-known/security.txt"))
      .status,
  ],
  [403, 200],
);

/* ------------------------------------------------------------------ */
step("index");

checkEqual(
  "default: index.html for /",
  (await get({}, "/static/")).text,
  "<h1>home</h1>",
);
checkEqual(
  "…for a directory with its slash",
  (await get({}, "/static/guide/")).text,
  "guide",
);
checkEqual(
  "true is the default",
  (await get({ index: true }, "/static/guide/")).text,
  "guide",
);
checkEqual(
  "false: a directory is a miss",
  (await get({ index: false, fallthrough: false }, "/static/")).status,
  404,
);
checkEqual(
  "a name",
  (await get({ index: "start.htm" }, "/static/docs/")).text,
  "start",
);
checkEqual(
  "…replaces index.html",
  (await get({ index: "start.htm", fallthrough: false }, "/static/guide/"))
    .status,
  404,
);
checkEqual(
  "names, tried in order",
  [
    (await get({ index: ["index.html", "start.htm"] }, "/static/guide/")).text,
    (await get({ index: ["index.html", "start.htm"] }, "/static/docs/")).text,
  ],
  ["guide", "start"],
);

/* ------------------------------------------------------------------ */
step("extensions");

checkEqual(
  "none by default ([]): /static/about is a miss",
  (await get({ fallthrough: false }, "/static/about")).status,
  404,
);
checkEqual(
  "without a dot",
  (await get({ extensions: ["html"] }, "/static/about")).text,
  "about",
);
checkEqual(
  "with a dot",
  (await get({ extensions: [".htm"] }, "/static/about")).text,
  "about (htm)",
);
checkEqual(
  "the first that exists wins",
  (await get({ extensions: ["htm", "html"] }, "/static/about")).text,
  "about (htm)",
);
checkEqual(
  "only used when the exact path is missing",
  (await get({ extensions: ["htm"] }, "/static/about.html")).text,
  "about",
);

/* ------------------------------------------------------------------ */
step("etag and lastModified");

const notesPath = join(root, "notes.txt");
const withValidators = await get({}, "/static/notes.txt");
checkEqual(
  'etag default: W/"size-mtime" in hex',
  withValidators.headers.get("etag"),
  expectedEtag(notesPath),
);
checkEqual(
  "lastModified default: the file's mtime as an HTTP date",
  withValidators.headers.get("last-modified"),
  new Date(Bun.file(notesPath).lastModified).toUTCString(),
);
checkEqual(
  "etag: false",
  (await get({ etag: false }, "/static/notes.txt")).headers.get("etag"),
  null,
);
checkEqual(
  "lastModified: false",
  (await get({ lastModified: false }, "/static/notes.txt")).headers.get(
    "last-modified",
  ),
  null,
);
checkEqual(
  "If-None-Match with the ETag: 304, no body",
  await (async () => {
    const answer = await get({}, "/static/notes.txt", {
      "If-None-Match": withValidators.headers.get("etag") ?? "",
    });
    return [answer.status, answer.text];
  })(),
  [304, ""],
);
checkEqual(
  "If-Modified-Since with the Last-Modified: 304",
  (
    await get({}, "/static/notes.txt", {
      "If-Modified-Since": withValidators.headers.get("last-modified") ?? "",
    })
  ).status,
  304,
);
checkEqual(
  "a stale ETag: 200",
  (await get({}, "/static/notes.txt", { "If-None-Match": 'W/"0-0"' })).status,
  200,
);

/* ------------------------------------------------------------------ */
step("maxAge and immutable");

/** Cache-Control for `options`. */
async function cacheControl(
  options: ServeStaticOptions,
): Promise<string | null> {
  return (await get(options, "/static/notes.txt")).headers.get("cache-control");
}

checkEqual("unset: no Cache-Control", await cacheControl({}), null);
checkEqual(
  "a number is milliseconds",
  await cacheControl({ maxAge: 60_000 }),
  "public, max-age=60",
);
checkEqual(
  "…rounded down to seconds",
  await cacheControl({ maxAge: 1500 }),
  "public, max-age=1",
);
checkEqual("0: none", await cacheControl({ maxAge: 0 }), null);
checkEqual("negative: none", await cacheControl({ maxAge: -1000 }), null);
for (const [value, seconds] of [
  ["500ms", 0],
  ["90s", 90],
  ["2m", 120],
  ["1h", 3600],
  ["1.5h", 5400],
  ["1d", 86_400],
  ["1w", 604_800],
  ["1y", 31_557_600],
  [" 1D ", 86_400],
] as const) {
  checkEqual(
    `"${value}"`,
    await cacheControl({ maxAge: value }),
    `public, max-age=${seconds}`,
  );
}
checkEqual(
  "a bare number string is milliseconds",
  await cacheControl({ maxAge: "2000" }),
  "public, max-age=2",
);
checkEqual(
  "an unknown unit: none",
  await cacheControl({ maxAge: "3 days" }),
  null,
);
checkEqual("nonsense: none", await cacheControl({ maxAge: "soon" }), null);
checkEqual(
  "immutable with maxAge",
  await cacheControl({ maxAge: "1d", immutable: true }),
  "public, max-age=86400, immutable",
);
checkEqual(
  "immutable without maxAge: none",
  await cacheControl({ immutable: true }),
  null,
);

/* ------------------------------------------------------------------ */
step("setHeaders");

const setHeaderCalls: { path: string; stat: Stats }[] = [];
const decorated = await get(
  {
    setHeaders: (res, path: string, stat: Stats) => {
      setHeaderCalls.push({ path, stat });
      res.setHeader("X-Custom", "yes");
      res.setHeader("Cache-Control", "no-store"); // runs last, so it wins
    },
    maxAge: "1h",
  },
  "/static/notes.txt",
);
checkEqual(
  "headers it sets are sent",
  decorated.headers.get("x-custom"),
  "yes",
);
checkEqual(
  "…and override the built-in ones",
  decorated.headers.get("cache-control"),
  "no-store",
);
checkEqual(
  "called once, with the absolute file path",
  setHeaderCalls.map((call) => call.path),
  [notesPath],
);
checkEqual(
  "…and the file's fs.Stats as stat",
  [
    setHeaderCalls[0]?.stat.isFile(),
    setHeaderCalls[0]?.stat.size,
    Math.floor(setHeaderCalls[0]?.stat.mtimeMs ?? 0),
  ],
  [true, 26, Math.floor(Bun.file(notesPath).lastModified)],
);
setHeaderCalls.length = 0;
await get({ setHeaders: () => {} }, "/static/missing.txt");
checkEqual("not called for a miss", setHeaderCalls.length, 0);

/* ------------------------------------------------------------------ */
step("redirect");

const unslashed = await get({}, "/static/guide");
checkEqual(
  "default (true): a directory without its trailing slash redirects",
  [unslashed.status, unslashed.headers.get("location")],
  [301, "/static/guide/"],
);
checkEqual(
  "redirect: true, explicitly",
  (await get({ redirect: true }, "/static/guide")).status,
  301,
);
checkEqual(
  "the query string is kept",
  (await get({}, "/static/guide?lang=en&v=2")).headers.get("location"),
  "/static/guide/?lang=en&v=2",
);
checkEqual(
  "a directory with no index still redirects",
  (await get({}, "/static/docs")).headers.get("location"),
  "/static/docs/",
);
checkEqual(
  "…and its slashed path is then a miss",
  (await get({ fallthrough: false }, "/static/docs/")).status,
  404,
);
const notRedirected = await get(
  { redirect: false, fallthrough: false },
  "/static/guide",
);
checkEqual(
  "redirect: false — a miss, a 404 error without fallthrough",
  [notRedirected.status, notRedirected.text],
  [404, "NotFoundError"],
);
checkEqual(
  "…which falls through by default",
  (await get({ redirect: false }, "/static/guide")).status,
  299,
);
checkEqual(
  "a file is never redirected",
  (await get({}, "/static/notes.txt")).status,
  200,
);

/* ------------------------------------------------------------------ */
step("metadataCacheTtl and metadataCacheMax");

const cacheRoot = await mkdtemp(join(tmpdir(), "bun-common-static-cache-"));
await writeFile(join(cacheRoot, "other.txt"), "other");

const defaultTtl = site({}, cacheRoot);
const noCache = site({ metadataCacheTtl: 0 }, cacheRoot);
const shortTtl = site({ metadataCacheTtl: 50 }, cacheRoot);
const oneEntry = site(
  { metadataCacheTtl: 60_000, metadataCacheMax: 1 },
  cacheRoot,
);
const noEntries = site(
  { metadataCacheTtl: 60_000, metadataCacheMax: 0 },
  cacheRoot,
);

for (const router of [defaultTtl, noCache, shortTtl, oneEntry, noEntries]) {
  checkEqual(
    "late.txt does not exist yet: a miss, falling through",
    (await router.fetch("/static/late.txt")).status,
    299,
  );
}
await oneEntry.fetch("/static/other.txt"); // the only slot now holds other.txt
await writeFile(join(cacheRoot, "late.txt"), "late");

checkEqual(
  "default TTL (1000ms): the miss is remembered",
  (await defaultTtl.fetch("/static/late.txt")).status,
  299,
);
checkEqual(
  "metadataCacheTtl: 0 — never cached",
  (await noCache.fetch("/static/late.txt")).status,
  200,
);
checkEqual(
  "metadataCacheMax: 0 — never cached",
  (await noEntries.fetch("/static/late.txt")).status,
  200,
);
checkEqual(
  "metadataCacheMax: 1 — evicted by the next path",
  (await oneEntry.fetch("/static/late.txt")).status,
  200,
);
await Bun.sleep(80);
checkEqual(
  "metadataCacheTtl: 50 — re-checked once expired",
  (await shortTtl.fetch("/static/late.txt")).status,
  200,
);
await Bun.sleep(1100);
checkEqual(
  "…and the default once its second is up",
  (await defaultTtl.fetch("/static/late.txt")).status,
  200,
);
await rm(cacheRoot, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
step("precompressed and compression");

const packedRoot = await mkdtemp(join(tmpdir(), "bun-common-static-packed-"));
const script = `export const rows = ${JSON.stringify(
  Array.from({ length: 150 }, (_, i) => ({ i, label: `row ${i}` })),
)};\n`;
const brSibling = brotliCompressSync(script);
// Level 1, so a sibling can never be mistaken for on-the-fly output.
const gzSibling = gzipSync(script, { level: 1 });
const zstSibling = zstdCompressSync(script);
const gzipSibling = gzipSync(`${script}// .gzip\n`, { level: 1 });
await writeFile(join(packedRoot, "app.js"), script);
await writeFile(join(packedRoot, "app.js.br"), brSibling);
await writeFile(join(packedRoot, "app.js.gz"), gzSibling);
await writeFile(join(packedRoot, "app.js.zst"), zstSibling);
await writeFile(join(packedRoot, "app.js.gzip"), gzipSibling);
await writeFile(join(packedRoot, "data.json"), script);
await writeFile(join(packedRoot, "orphan.js.gz"), gzSibling);

/** `GET path` from `packedRoot` with `options`, and an `Accept-Encoding`. */
async function packed(
  options: ServeStaticOptions,
  path: string,
  accept: string | null,
  headers: Record<string, string> = {},
) {
  const response = await site(options, packedRoot).fetch(path, {
    headers:
      accept === null ? headers : { "accept-encoding": accept, ...headers },
  });
  return {
    status: response.status,
    encoding: response.headers.get("content-encoding"),
    type: response.headers.get("content-type") ?? "",
    length: response.headers.get("content-length"),
    vary: response.headers.get("vary"),
    etag: response.headers.get("etag"),
    bytes: Buffer.from(await response.bytes()),
  };
}

const onTheFly = await packed({}, "/static/app.js", "gzip");
checkEqual(
  "compression default (true): a compressible file is gzipped on the fly",
  [onTheFly.encoding, onTheFly.length, gunzipSync(onTheFly.bytes).toString()],
  ["gzip", null, script],
);
check(
  "precompressed default (false): the .gz sibling is not used",
  !onTheFly.bytes.equals(gzSibling),
);

const fromBr = await packed(
  { precompressed: true },
  "/static/app.js",
  "gzip, br",
);
checkEqual(
  "precompressed: true — app.js.br, as it is on disk",
  [fromBr.encoding, fromBr.bytes.equals(brSibling), fromBr.length],
  ["br", true, String(brSibling.length)],
);
checkEqual(
  "…with the original's Content-Type and Vary",
  [fromBr.type.startsWith("text/javascript"), fromBr.vary],
  [true, "Accept-Encoding"],
);
checkEqual(
  "q-values, * and the default br, zstd, gzip order pick the sibling",
  [
    (await packed({ precompressed: true }, "/static/app.js", "gzip, zstd"))
      .encoding,
    (await packed({ precompressed: true }, "/static/app.js", "br;q=0, *"))
      .encoding,
    (
      await packed(
        { precompressed: true },
        "/static/app.js",
        "br;q=0, zstd;q=0, *",
      )
    ).encoding,
    (
      await packed(
        { precompressed: true },
        "/static/app.js",
        "gzip;q=1, br;q=0.5",
      )
    ).encoding,
  ],
  ["zstd", "zstd", "gzip", "gzip"],
);
const identity = await packed(
  { precompressed: true },
  "/static/app.js",
  "identity",
);
checkEqual(
  "identity: the original, with Vary",
  [identity.encoding, identity.bytes.toString() === script, identity.vary],
  [null, true, "Accept-Encoding"],
);

const tags = [
  fromBr.etag,
  (await packed({ precompressed: true }, "/static/app.js", "gzip")).etag,
  identity.etag,
];
checkEqual("each encoding has its own ETag", new Set(tags).size, 3);
checkEqual(
  "a conditional request is answered per encoding",
  [
    (
      await packed({ precompressed: true }, "/static/app.js", "br", {
        "If-None-Match": fromBr.etag ?? "",
      })
    ).status,
    (
      await packed({ precompressed: true }, "/static/app.js", "gzip", {
        "If-None-Match": fromBr.etag ?? "",
      })
    ).status,
  ],
  [304, 200],
);

checkEqual(
  "precompressed: { enabled: false } — siblings ignored",
  (
    await packed({ precompressed: { enabled: false } }, "/static/app.js", "br")
  ).bytes.equals(brSibling),
  false,
);
checkEqual(
  "extensions: { gzip: 'gzip' } — merged over the defaults",
  (
    await packed(
      { precompressed: { extensions: { gzip: "gzip" } } },
      "/static/app.js",
      "gzip",
    )
  ).bytes.equals(gzipSibling),
  true,
);
checkEqual(
  "extensions: { zstd: [] } turns a coding off",
  (
    await packed(
      { precompressed: { extensions: { zstd: [] }, fallback: "identity" } },
      "/static/app.js",
      "zstd",
    )
  ).encoding,
  null,
);
checkEqual(
  "encodings: ['gzip', '*'] — gzip wins a tie",
  (
    await packed(
      { precompressed: { encodings: ["gzip", "*"] } },
      "/static/app.js",
      "br, gzip",
    )
  ).encoding,
  "gzip",
);
checkEqual(
  "fallback: 'compress' (default) and 'identity' when no sibling exists",
  [
    (await packed({ precompressed: true }, "/static/data.json", "gzip"))
      .encoding,
    (
      await packed(
        { precompressed: { fallback: "identity" } },
        "/static/data.json",
        "gzip",
      )
    ).encoding,
  ],
  ["gzip", null],
);
checkEqual(
  "compression: false — never on the fly, even as the fallback",
  [
    (await packed({ compression: false }, "/static/app.js", "gzip")).encoding,
    (
      await packed(
        { compression: false, precompressed: true },
        "/static/data.json",
        "gzip",
      )
    ).encoding,
  ],
  [null, null],
);
checkEqual(
  "compression: { … } — compression()'s options",
  [
    (
      await packed(
        { compression: { threshold: "1mb" } },
        "/static/app.js",
        "gzip",
      )
    ).encoding,
    (
      await packed(
        { compression: { encodings: ["zstd"] } },
        "/static/app.js",
        "gzip, zstd",
      )
    ).encoding,
  ],
  [null, "zstd"],
);
const direct = await packed(
  { precompressed: true },
  "/static/app.js.gz",
  "gzip",
);
checkEqual(
  "a sibling requested by its own name is an ordinary file",
  [direct.encoding, direct.type.startsWith("application/gzip")],
  [null, true],
);
checkEqual(
  "a sibling whose original is missing is never served",
  (
    await packed(
      { precompressed: true, fallthrough: false },
      "/static/orphan.js",
      "gzip",
    )
  ).status,
  404,
);
await checkRejects(
  "an encoding without extensions in precompressed.encodings throws",
  () =>
    createServeStaticHandler(packedRoot, {
      precompressed: { encodings: ["deflate"] },
    }),
  { name: "TypeError" },
);

const packedServer = new BunHttpAdapter();
packedServer.useStaticAssets(packedRoot, {
  prefix: "/static",
  precompressed: true,
});
await packedServer.listen(0);
try {
  const partial = await fetch(
    `http://127.0.0.1:${packedServer.listeningPort}/static/app.js`,
    {
      headers: { "accept-encoding": "br", Range: "bytes=0-9" },
      decompress: false,
    },
  );
  checkEqual(
    "a range applies to the precompressed bytes",
    [
      partial.status,
      partial.headers.get("content-encoding"),
      Buffer.from(await partial.bytes()).equals(brSibling.subarray(0, 10)),
    ],
    [206, "br", true],
  );
} finally {
  await packedServer.close();
}
await rm(packedRoot, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
step("Ranges, through a real server");

const server = new BunHttpAdapter();
server.useStaticAssets(root, { prefix: "/static" });
await server.listen(0);
try {
  const base = `http://127.0.0.1:${server.listeningPort}`;
  const partial = await fetch(`${base}/static/notes.txt`, {
    headers: { Range: "bytes=0-4" },
  });
  checkEqual(
    "Range: bytes=0-4 → 206",
    [
      partial.status,
      partial.headers.get("content-range"),
      await partial.text(),
    ],
    [206, "bytes 0-4/26", "abcde"],
  );
  const suffix = await fetch(`${base}/static/notes.txt`, {
    headers: { Range: "bytes=-3" },
  });
  checkEqual(
    "a suffix range",
    [suffix.status, await suffix.text()],
    [206, "xyz"],
  );
  const full = await fetch(`${base}/static/notes.txt`);
  checkEqual(
    "no Range: 200 and the whole file",
    [full.status, (await full.text()).length],
    [200, 26],
  );
} finally {
  await server.close();
}

await rm(root, { recursive: true, force: true });

summary();
