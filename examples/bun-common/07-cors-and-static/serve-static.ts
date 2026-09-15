/**
 * Serving static files — `createServeStaticHandler` and every
 * `ServeStaticOptions` field.
 *
 * ```bash
 * bun 07-cors-and-static/serve-static.ts
 * ```
 *
 * `createServeStaticHandler(root, options)` answers `{ prefix, handler }`.
 * Register the handler on `${prefix}/*` — which is exactly what
 * `adapter.useStaticAssets(root, options)` does for you.
 *
 * The files served live in `fixtures/public/`:
 *
 * ```text
 * index.html   about.html   alphabet.txt   .hidden.txt
 * css/site.css guide/index.html            docs/start.htm
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - `fallthrough` defaults to `true`, as in `serve-static`: a miss (and a
 *   denied dotfile, or a method other than GET/HEAD) goes to the next route,
 *   and with none left the adapter answers 404. `fallthrough: false` forwards
 *   the client error as `next(err)` instead (a 405 for another method).
 *   `dotfiles: "ignore"` (the default) is a miss too. These examples run on a
 *   `BunHttpAdapter`, whose `fetch()` renders a forwarded error as a page.
 * - `ETag` and `Last-Modified` are on by default, and a matching conditional
 *   request gets `304` with no work from you.
 * - Range requests are served by `Bun.serve` itself, so that section binds a
 *   real socket (port 0). Everything else uses `router.fetch()`.
 * - Only file *metadata* is cached, for `metadataCacheTtl` ms — including
 *   misses, so a file created just after a 404 may 404 until the entry expires.
 * - A directory requested without its trailing slash is a `301` to the slashed
 *   path, query string kept (`redirect`, default `true`) — as `serve-static`
 *   does, so relative links in its index resolve. `redirect: false` makes it a
 *   miss instead.
 * - `setHeaders(res, path, stat)` gets the file's `fs.Stats`.
 * - `precompressed` serves an `app.js.br`/`.zst`/`.gz` sibling a client
 *   accepts; `compression` (on by default) compresses everything else on the
 *   fly — only compressible types, only over 1 KiB, never a range.
 */
import type {
  RouterErrorMiddlewareHandler,
  ServeStaticOptions,
} from "@kingsleyweb/bun-common";
import type { Stats } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import {
  BunHttpAdapter,
  BunRouter,
  createServeStaticHandler,
} from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Serving static files");

const PUBLIC = join(import.meta.dir, "fixtures", "public");

/**
 * An adapter serving `root` under `/static` with `options`. Its `fetch()`
 * answers a forwarded error as Express's final handler would.
 */
function site(
  options: ServeStaticOptions = {},
  root: string = PUBLIC,
): BunRouter {
  const router = new BunHttpAdapter();
  const { prefix, handler } = createServeStaticHandler(root, {
    prefix: "/static",
    ...options,
  });
  router.get(`${prefix}/*`, handler);
  return router;
}

/** The status, the headers that matter here, and a short body. */
async function view(
  response: Response,
): Promise<Record<string, string | number | null>> {
  const body = await response.text();
  return {
    status: response.status,
    "content-type": response.headers.get("content-type"),
    "content-length": response.headers.get("content-length"),
    etag: response.headers.get("etag"),
    "last-modified": response.headers.get("last-modified"),
    "cache-control": response.headers.get("cache-control"),
    body: body.length > 40 ? `${body.slice(0, 40)}…` : body,
  };
}

/* ------------------------------------------------------------------ */
step("Defaults");

const plain = site();
show("GET /static/ — index.html", await view(await plain.fetch("/static/")));
show(
  "GET /static/css/site.css — type from the extension",
  await view(await plain.fetch("/static/css/site.css")),
);
show(
  "GET /static/guide/ — a directory, served from its index",
  await view(await plain.fetch("/static/guide/")),
);
show(
  "GET /static/missing.txt",
  await view(await plain.fetch("/static/missing.txt")),
);
show(
  "Accept-Ranges is advertised on every file",
  (await plain.fetch("/static/alphabet.txt")).headers.get("accept-ranges"),
);

/* ------------------------------------------------------------------ */
step("Conditional requests: 304 from ETag or Last-Modified");

const first = await plain.fetch("/static/about.html");
const tag = first.headers.get("etag") ?? "";
const modified = first.headers.get("last-modified") ?? "";
show(
  "If-None-Match with the ETag",
  (
    await plain.fetch("/static/about.html", {
      headers: { "If-None-Match": tag },
    })
  ).status,
);
show(
  "If-Modified-Since with the Last-Modified",
  (
    await plain.fetch("/static/about.html", {
      headers: { "If-Modified-Since": modified },
    })
  ).status,
);

/* ------------------------------------------------------------------ */
step("etag: false, lastModified: false");

show(
  "etag: false",
  await view(await site({ etag: false }).fetch("/static/about.html")),
);
show(
  "lastModified: false",
  await view(await site({ lastModified: false }).fetch("/static/about.html")),
);

/* ------------------------------------------------------------------ */
step("maxAge and immutable → Cache-Control");

for (const options of [
  { maxAge: 60_000 },
  { maxAge: "1d", immutable: true },
  { maxAge: "2h" },
  { maxAge: "soon" },
  { immutable: true },
] satisfies ServeStaticOptions[]) {
  const response = await site(options).fetch("/static/css/site.css");
  show(JSON.stringify(options), response.headers.get("cache-control"));
}

/* ------------------------------------------------------------------ */
step("index: false, a name, or names in order of preference");

show("index: false", (await site({ index: false }).fetch("/static/")).status);
show(
  "index: 'start.htm' for /static/docs/",
  await view(await site({ index: "start.htm" }).fetch("/static/docs/")),
);
const preferred = site({ index: ["index.html", "start.htm"] });
show(
  "index: ['index.html', 'start.htm'] — /static/guide/",
  (await preferred.fetch("/static/guide/")).status,
);
show(
  "…and /static/docs/, which has only start.htm",
  (await preferred.fetch("/static/docs/")).status,
);

/* ------------------------------------------------------------------ */
step("extensions: try these when the path has none");

show(
  "no extensions: /static/about",
  (await plain.fetch("/static/about")).status,
);
show(
  "extensions: ['html'] — /static/about",
  await view(await site({ extensions: ["html"] }).fetch("/static/about")),
);
show(
  "extensions: ['.html', '.htm'] — /static/docs/start",
  (await site({ extensions: [".html", ".htm"] }).fetch("/static/docs/start"))
    .status,
);

/* ------------------------------------------------------------------ */
step("dotfiles: ignore (default), deny, allow");

for (const dotfiles of ["ignore", "deny", "allow"]) {
  // fallthrough: false, so ignore and deny show their own status.
  const response = await site({ dotfiles, fallthrough: false }).fetch(
    "/static/.hidden.txt",
  );
  show(`dotfiles: ${dotfiles}`, {
    status: response.status,
    body: (await response.text()).includes("<pre>")
      ? "(the adapter's error page)"
      : "served",
  });
}

/* ------------------------------------------------------------------ */
step("fallthrough (default true): hand a miss to the next route");

const layered = new BunRouter();
const assets = createServeStaticHandler(PUBLIC, { prefix: "/static" });
layered.get(`${assets.prefix}/*`, assets.handler);
layered.get("/static/*", (req, res) => {
  res.status(200).send(`generated on the fly for ${req.path}`);
});
show("an existing file", await view(await layered.fetch("/static/about.html")));
show(
  "a miss, falling through",
  await view(await layered.fetch("/static/report.csv")),
);
show(
  "a dotfile falls through too (ignore is a miss)",
  await view(await layered.fetch("/static/.hidden.txt")),
);

const strict = new BunRouter();
const strictAssets = createServeStaticHandler(PUBLIC, {
  prefix: "/static",
  fallthrough: false,
});
strict.all(`${strictAssets.prefix}/*`, strictAssets.handler);
strict.use(((err, _req, res, _next) => {
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).send(`forwarded: ${(err as Error).name}`);
}) satisfies RouterErrorMiddlewareHandler);
show(
  "fallthrough: false — a miss is next(err)",
  await view(await strict.fetch("/static/report.csv")),
);
const post = await strict.fetch("/static/about.html", { method: "POST" });
show("fallthrough: false — a POST is 405", {
  status: post.status,
  allow: post.headers.get("allow"),
});

/* ------------------------------------------------------------------ */
step("redirect: a directory without its trailing slash");

for (const redirect of [true, false]) {
  const response = await site({ redirect }).fetch("/static/guide?lang=en");
  show(`redirect: ${redirect} — GET /static/guide`, {
    status: response.status,
    location: response.headers.get("location"),
  });
}

/* ------------------------------------------------------------------ */
step("setHeaders(res, path, stat)");

const branded = site({
  setHeaders: (res, path: string, stat: Stats) => {
    res.setHeader("X-Served-File", basename(path));
    res.setHeader("X-File-Size", String(stat.size));
    res.setHeader("X-File-Modified", stat.mtime.toISOString());
    if (path.endsWith(".html")) {
      res.setHeader("Content-Security-Policy", "default-src 'self'");
    }
  },
});
const brandedResponse = await branded.fetch("/static/about.html");
show("headers set per file", {
  "x-served-file": brandedResponse.headers.get("x-served-file"),
  "x-file-size": brandedResponse.headers.get("x-file-size"),
  "x-file-modified": brandedResponse.headers.get("x-file-modified"),
  "content-security-policy": brandedResponse.headers.get(
    "content-security-policy",
  ),
});

/* ------------------------------------------------------------------ */
step("metadataCacheTtl and metadataCacheMax: misses are cached too");

const scratch = await mkdtemp(join(tmpdir(), "bun-common-static-"));
await writeFile(join(scratch, "other.txt"), "other");

const cached = site({ metadataCacheTtl: 60_000 }, scratch);
const uncached = site({ metadataCacheTtl: 0 }, scratch);
const tiny = site({ metadataCacheTtl: 60_000, metadataCacheMax: 1 }, scratch);

for (const router of [cached, uncached, tiny]) {
  await router.fetch("/static/late.txt"); // a miss, remembered where cached
}
await tiny.fetch("/static/other.txt"); // evicts late.txt from a one-entry cache
await writeFile(join(scratch, "late.txt"), "created after the first request");

show(
  "metadataCacheTtl: 60000 — still the remembered miss",
  (await cached.fetch("/static/late.txt")).status,
);
show(
  "metadataCacheTtl: 0 — stats every request",
  (await uncached.fetch("/static/late.txt")).status,
);
show(
  "metadataCacheMax: 1 — the miss was evicted",
  (await tiny.fetch("/static/late.txt")).status,
);
await rm(scratch, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
step("precompressed and compression: .br/.gz siblings, or on the fly");

// Siblings are generated into a scratch copy here, so none can go stale.
const packed = await mkdtemp(join(tmpdir(), "bun-common-static-packed-"));
const page = `${await Bun.file(join(PUBLIC, "about.html")).text()}\n<!-- ${"padding ".repeat(300)}-->\n`;
await writeFile(join(packed, "page.html"), page);
await writeFile(join(packed, "page.html.br"), brotliCompressSync(page));
await writeFile(join(packed, "page.html.gz"), gzipSync(page, { level: 9 }));

/** The encoding-related headers of `path`, for an `Accept-Encoding`. */
async function encoded(
  router: BunRouter,
  path: string,
  accept: string,
): Promise<Record<string, string | number | null>> {
  const response = await router.fetch(path, {
    headers: { "accept-encoding": accept },
  });
  return {
    "content-encoding": response.headers.get("content-encoding"),
    "content-type": response.headers.get("content-type"),
    "content-length": response.headers.get("content-length"),
    vary: response.headers.get("vary"),
    etag: response.headers.get("etag"),
    bytes: (await response.bytes()).length,
  };
}

const siblings = site({ precompressed: true }, packed);
show("uncompressed page.html is", page.length);
show(
  "precompressed: true, br accepted — page.html.br from disk",
  await encoded(siblings, "/static/page.html", "gzip, br"),
);
show(
  "…gzip only — page.html.gz, with an ETag of its own",
  await encoded(siblings, "/static/page.html", "gzip"),
);
show(
  "…identity — the original, still with Vary",
  await encoded(siblings, "/static/page.html", "identity"),
);
show(
  "precompressed: { fallback: 'identity' }, zstd (no .zst) — sent as it is",
  await encoded(
    site({ precompressed: { fallback: "identity" } }, packed),
    "/static/page.html",
    "zstd",
  ),
);
show(
  "default (no precompressed) — compressed on the fly",
  await encoded(site({}, packed), "/static/page.html", "zstd"),
);
show(
  "compression: false — exactly the bytes on disk",
  await encoded(
    site({ compression: false }, packed),
    "/static/page.html",
    "gzip",
  ),
);
show(
  "page.html.gz requested by name — an ordinary file",
  await encoded(siblings, "/static/page.html.gz", "gzip"),
);
await rm(packed, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
step("Range requests — through a real server, via useStaticAssets");

const server = new BunHttpAdapter();
server.useStaticAssets(PUBLIC, { prefix: "/static", maxAge: "1h" });
await server.listen(0);

try {
  const base = `http://127.0.0.1:${server.listeningPort}`;
  const partial = await fetch(`${base}/static/alphabet.txt`, {
    headers: { Range: "bytes=0-4" },
  });
  show("Range: bytes=0-4", {
    status: partial.status,
    contentRange: partial.headers.get("content-range"),
    body: await partial.text(),
  });

  const tail = await fetch(`${base}/static/alphabet.txt`, {
    headers: { Range: "bytes=-3" },
  });
  show("Range: bytes=-3 (the last three bytes)", {
    status: tail.status,
    body: JSON.stringify(await tail.text()),
  });
} finally {
  await server.close();
}
