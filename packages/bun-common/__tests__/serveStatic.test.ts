import type { Stats } from "node:fs";
import type { ServeStaticOptions } from "../lib/types/general";
import { Buffer } from "node:buffer";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import * as zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { createServeStaticHandler } from "../lib/serveStatic";

/** Root of the fixture tree served by the adapters under test. */
let root: string;

/** Adapters started per option-set, torn down in `afterAll`. */
const started: BunHttpAdapter[] = [];

/**
 * Boots an adapter serving {@link root} under `/static` with the given options
 * and returns its base URL.
 */
async function serve(
  options: Parameters<BunHttpAdapter["useStaticAssets"]>[1] = {},
): Promise<string> {
  const adapter = new BunHttpAdapter(0, {
    request: { parseBody: false, parseCookies: false, parseQuery: false },
  });
  adapter.useStaticAssets(root, { prefix: "/static", ...options });
  // Port 0 — the OS assigns, so parallel suites never collide.
  await adapter.listen(0);
  started.push(adapter);
  return `http://127.0.0.1:${adapter.listeningPort}`;
}

beforeAll(() => {
  root = join(tmpdir(), `bun-common-serve-static-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "nested"), { recursive: true });
  mkdirSync(join(root, "empty-dir"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<h1>home</h1>");
  writeFileSync(join(root, "MixedCase.TXT"), "mixed-case-body");
  writeFileSync(join(root, "with space.txt"), "spaced");
  writeFileSync(join(root, "about.html"), "about-page");
  writeFileSync(join(root, ".secret"), "dotfile-body");
  writeFileSync(join(root, "nested", "index.html"), "nested-index");
  writeFileSync(join(root, "big.bin"), "x".repeat(5000));
});

afterAll(async () => {
  for (const adapter of started) {
    await adapter.close();
  }
  rmSync(root, { recursive: true, force: true });
});

describe("useStaticAssets: file resolution", () => {
  it("serves a file preserving path case", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/MixedCase.TXT`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mixed-case-body");
  });

  it("percent-decodes the path", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/with%20space.txt`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("spaced");
  });

  it("answers 404 — not 500 — for a missing file", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/nope.txt`);

    expect(response.status).toBe(404);
  });

  it("falls through to the next handler when fallthrough is set", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: false, parseCookies: false, parseQuery: false },
    });
    adapter.useStaticAssets(root, { prefix: "/static", fallthrough: true });
    adapter.get("/static/*", (_req, res) => {
      res.status(200).send("fell-through");
    });
    await adapter.listen(0);
    started.push(adapter);

    const response = await fetch(
      `http://127.0.0.1:${adapter.listeningPort}/static/nope.txt`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fell-through");
  });

  it("serves index.html for a directory", async () => {
    const base = await serve();

    const rootDir = await fetch(`${base}/static/`);
    expect(rootDir.status).toBe(200);
    expect(await rootDir.text()).toBe("<h1>home</h1>");

    const nested = await fetch(`${base}/static/nested`);
    expect(nested.status).toBe(200);
    expect(await nested.text()).toBe("nested-index");
  });

  it("honours index: false", async () => {
    const base = await serve({ index: false });
    const response = await fetch(`${base}/static/`);

    expect(response.status).toBe(404);
  });

  it("applies extension fallbacks", async () => {
    const base = await serve({ extensions: ["html"] });
    const response = await fetch(`${base}/static/about`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("about-page");
  });
});

describe("useStaticAssets: dotfiles", () => {
  it("ignores dotfiles by default", async () => {
    const base = await serve();
    expect((await fetch(`${base}/static/.secret`)).status).toBe(404);
  });

  it("denies dotfiles with 403 when configured", async () => {
    const base = await serve({ dotfiles: "deny" });
    expect((await fetch(`${base}/static/.secret`)).status).toBe(403);
  });

  it("serves dotfiles when allowed", async () => {
    const base = await serve({ dotfiles: "allow" });
    const response = await fetch(`${base}/static/.secret`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("dotfile-body");
  });
});

describe("useStaticAssets: redirect", () => {
  /** A router serving {@link root} under `/static`, with a fallthrough route. */
  function site(options: Parameters<typeof createServeStaticHandler>[1] = {}) {
    const router = new BunRouter();
    const { prefix, handler } = createServeStaticHandler(root, {
      prefix: "/static",
      ...options,
    });
    router.get(`${prefix}/*`, handler);
    router.get("/static/*", (_req, res) => {
      res.status(299).send("next");
    });
    return router;
  }

  it("301s a directory without its trailing slash, keeping the query", async () => {
    const response = await site().fetch("/static/nested?a=1&b=2");

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/static/nested/?a=1&b=2");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("/static/nested/?a=1&amp;b=2");
  });

  it("redirects through a real server too", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/nested`, {
      redirect: "manual",
    });

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/static/nested/");
  });

  it("redirects a directory with no index, whose slashed path is a miss", async () => {
    const router = site();
    const unslashed = await router.fetch("/static/empty-dir");
    expect(unslashed.status).toBe(301);
    expect(unslashed.headers.get("location")).toBe("/static/empty-dir/");
    expect((await router.fetch("/static/empty-dir/")).status).toBe(404);
  });

  it("does not let a cached slashed lookup hide the redirect", async () => {
    const router = site({ metadataCacheTtl: 60_000 });
    expect((await router.fetch("/static/nested/")).status).toBe(200);
    expect((await router.fetch("/static/nested")).status).toBe(301);
    expect((await router.fetch("/static/nested/")).status).toBe(200);
  });

  it("treats a directory as a miss with redirect: false", async () => {
    expect(
      (await site({ redirect: false }).fetch("/static/nested")).status,
    ).toBe(404);
    expect(
      (
        await site({ redirect: false, fallthrough: true }).fetch(
          "/static/nested",
        )
      ).status,
    ).toBe(299);
  });

  it("never redirects a file", async () => {
    const response = await site().fetch("/static/about.html");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("ignores dotfiles as a miss: next() with fallthrough, 404 without", async () => {
    expect(
      (await site({ fallthrough: true }).fetch("/static/.secret")).status,
    ).toBe(299);
    expect((await site().fetch("/static/.secret")).status).toBe(404);
  });

  it("passes setHeaders the file's fs.Stats", async () => {
    const seen: Stats[] = [];
    await site({
      setHeaders: (_res: unknown, _path: string, stat: Stats) => {
        seen.push(stat);
      },
    }).fetch("/static/about.html");

    expect(seen).toHaveLength(1);
    expect(seen[0].isFile()).toBe(true);
    expect(seen[0].size).toBe("about-page".length);
    expect(seen[0].mtime).toBeInstanceOf(Date);
  });
});

describe("useStaticAssets: validators and caching headers", () => {
  it("emits ETag and Last-Modified by default", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/index.html`);

    expect(response.headers.get("etag")).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(response.headers.get("last-modified")).toBeTruthy();
  });

  it("omits the ETag when etag: false", async () => {
    const base = await serve({ etag: false });
    const response = await fetch(`${base}/static/index.html`);

    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("last-modified")).toBeTruthy();
  });

  it("omits Last-Modified when lastModified: false", async () => {
    const base = await serve({ lastModified: false });
    const response = await fetch(`${base}/static/index.html`);

    expect(response.headers.get("last-modified")).toBeNull();
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const base = await serve();
    const first = await fetch(`${base}/static/index.html`);
    const tag = first.headers.get("etag");
    expect(tag).toBeTruthy();

    const second = await fetch(`${base}/static/index.html`, {
      headers: { "If-None-Match": tag as string },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("derives Cache-Control from maxAge and immutable", async () => {
    const base = await serve({ maxAge: "1d", immutable: true });
    const response = await fetch(`${base}/static/index.html`);

    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=86400, immutable",
    );
  });

  it("sends no Cache-Control when maxAge is unset", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/index.html`);

    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("invokes setHeaders", async () => {
    const base = await serve({
      setHeaders: (res: any) => res.setHeader("X-Custom", "yes"),
    });
    const response = await fetch(`${base}/static/index.html`);

    expect(response.headers.get("x-custom")).toBe("yes");
  });
});

describe("useStaticAssets: range requests", () => {
  it("serves a byte range as 206", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/big.bin`, {
      headers: { Range: "bytes=0-99" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-99/5000");
    expect((await response.text()).length).toBe(100);
  });

  it("advertises Accept-Ranges on a full response", async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/big.bin`);

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });
});

describe("useStaticAssets: traversal containment", () => {
  /** Sends a raw request line so `..` survives client-side normalisation. */
  function raw(port: number, target: string): Promise<string> {
    return new Promise((resolve) => {
      let buffer = "";
      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open: (socket) =>
            void socket.write(
              `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
            ),
          data: (_socket, chunk) => {
            buffer += new TextDecoder().decode(chunk);
          },
          close: () => resolve(buffer),
          error: () => resolve(buffer),
        },
      });
    });
  }

  it("refuses encoded and literal traversal", async () => {
    const outside = join(tmpdir(), `bun-common-outside-${process.pid}.txt`);
    writeFileSync(outside, "secret-marker");

    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: false, parseCookies: false, parseQuery: false },
    });
    adapter.useStaticAssets(root, { prefix: "/static" });
    await adapter.listen(0);
    started.push(adapter);
    const port = adapter.listeningPort as number;

    for (const target of [
      "/static/../../../../etc/passwd",
      `/static/%2e%2e/${outside.split("/").pop()}`,
      "/static/..%2f..%2fetc%2fpasswd",
    ]) {
      const raw404 = await raw(port, target);
      expect(raw404).not.toContain("secret-marker");
      expect(raw404).not.toContain("root:x:");
    }

    rmSync(outside, { force: true });
  });
});

describe("useStaticAssets: metadata cache", () => {
  it("reflects a file rewritten after the TTL expires", async () => {
    const file = join(root, "volatile.txt");
    writeFileSync(file, "first");

    const base = await serve({ metadataCacheTtl: 1 });
    expect(await (await fetch(`${base}/static/volatile.txt`)).text()).toBe(
      "first",
    );

    writeFileSync(file, "second-value");
    await Bun.sleep(20);

    const response = await fetch(`${base}/static/volatile.txt`);
    expect(await response.text()).toBe("second-value");
    expect(response.headers.get("content-length")).toBe("12");
  });

  it("serves correctly with the cache disabled", async () => {
    const base = await serve({ metadataCacheTtl: 0 });
    const response = await fetch(`${base}/static/index.html`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>home</h1>");
  });
});

describe("createServeStaticHandler: precompressed siblings and on-the-fly compression", () => {
  /** Root of this suite's tree: originals, siblings, an outside file. */
  let assets: string;
  /** The JavaScript original, well over the compression threshold. */
  const script = `export const data = ${JSON.stringify(
    Array.from({ length: 150 }, (_, i) => ({ id: i, label: `row ${i}` })),
  )};\n`;
  /** Each sibling's bytes, by file name. */
  const siblings: Record<string, Buffer> = {};

  /** Writes a sibling of `name` compressed with `encode`. */
  function writeSibling(name: string, bytes: Buffer): void {
    siblings[name] = bytes;
    writeFileSync(join(assets, name), bytes);
  }

  beforeAll(() => {
    const base = join(tmpdir(), `bun-common-precompressed-${process.pid}`);
    rmSync(base, { recursive: true, force: true });
    assets = join(base, "public");
    mkdirSync(assets, { recursive: true });

    writeFileSync(join(assets, "app.js"), script);
    writeSibling("app.js.br", zlib.brotliCompressSync(script));
    // Level 1, so a sibling never matches what on-the-fly compression makes.
    writeSibling("app.js.gz", zlib.gzipSync(script, { level: 1 }));
    writeSibling(
      "app.js.zst",
      zlib.zstdCompressSync(script, {
        params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 },
      }),
    );
    writeSibling("app.js.gzip", zlib.gzipSync(`${script}// .gzip\n`));

    writeFileSync(join(assets, "only-gz.css"), `body{}${" ".repeat(2000)}`);
    writeSibling("only-gz.css.gz", zlib.gzipSync(`body{}${" ".repeat(2000)}`));

    writeFileSync(join(assets, "plain.json"), script);
    writeSibling("orphan.js.gz", zlib.gzipSync(script));

    writeFileSync(join(assets, ".hidden.js"), script);
    writeSibling(".hidden.js.gz", zlib.gzipSync(script));

    writeFileSync(join(base, "outside.js"), script);
    writeFileSync(join(base, "outside.js.gz"), zlib.gzipSync(script));
  });

  afterAll(() => {
    rmSync(join(assets, ".."), { recursive: true, force: true });
  });

  /** A router serving `assets` under `/static` with `options`. */
  function site(options: ServeStaticOptions = {}): BunRouter {
    const router = new BunRouter();
    const { prefix, handler } = createServeStaticHandler(assets, {
      prefix: "/static",
      ...options,
    });
    router.get(`${prefix}/*`, handler);
    return router;
  }

  /** GETs `path` with `Accept-Encoding: accept` (none when `null`). */
  async function get(
    router: BunRouter,
    path: string,
    accept: string | null,
    headers: Record<string, string> = {},
  ) {
    const response = await router.fetch(path, {
      headers:
        accept === null ? headers : { "accept-encoding": accept, ...headers },
    });
    return {
      status: response.status,
      headers: response.headers,
      encoding: response.headers.get("content-encoding"),
      bytes: Buffer.from(await response.bytes()),
    };
  }

  it("serves the sibling of each accepted coding", async () => {
    const router = site({ precompressed: true });
    for (const [accept, name] of [
      ["br", "app.js.br"],
      ["gzip", "app.js.gz"],
      ["zstd", "app.js.zst"],
    ] as const) {
      const result = await get(router, "/static/app.js", accept);
      expect(result.status).toBe(200);
      expect(result.encoding).toBe(accept);
      expect(result.bytes.equals(siblings[name])).toBe(true);
      expect(result.headers.get("content-length")).toBe(
        String(siblings[name].length),
      );
      expect(result.headers.get("content-type")).toStartWith("text/javascript");
      expect(result.headers.get("vary")).toBe("Accept-Encoding");
    }
  });

  it("negotiates q-values, wildcards and the preference order", async () => {
    const router = site({ precompressed: true });
    const cases: [string, string | null][] = [
      ["gzip, br, zstd", "br"],
      ["gzip, zstd", "zstd"],
      ["gzip;q=0.5, br;q=0.4", "gzip"],
      ["br;q=0, gzip", "gzip"],
      ["*", "br"],
      ["br;q=0, *", "zstd"],
      ["br;q=0, zstd;q=0, *", "gzip"],
      ["identity", null],
      ["identity, gzip;q=0.5", null],
      ["*;q=0, identity", null],
    ];
    for (const [accept, expected] of cases) {
      // fallback: "identity", so a miss shows as no Content-Encoding.
      const result = await get(
        site({ precompressed: { fallback: "identity" } }),
        "/static/app.js",
        accept,
      );
      expect([accept, result.encoding]).toEqual([accept, expected]);
    }
    expect((await get(router, "/static/app.js", null)).encoding).toBeNull();

    const gzipFirst = site({ precompressed: { encodings: ["gzip", "*"] } });
    expect(
      (await get(gzipFirst, "/static/app.js", "br, gzip, zstd")).encoding,
    ).toBe("gzip");
  });

  it("tries the next acceptable coding when a sibling is missing", async () => {
    const result = await get(
      site({ precompressed: true }),
      "/static/only-gz.css",
      "br, zstd, gzip",
    );
    expect(result.encoding).toBe("gzip");
    expect(result.bytes.equals(siblings["only-gz.css.gz"])).toBe(true);
    expect(result.headers.get("content-type")).toStartWith("text/css");
  });

  it("gives each encoding its own ETag and Last-Modified, and answers 304 per encoding", async () => {
    const router = site({ precompressed: true });
    const br = await get(router, "/static/app.js", "br");
    const gz = await get(router, "/static/app.js", "gzip");
    const plain = await get(
      site({ precompressed: true, compression: false }),
      "/static/app.js",
      "identity",
    );
    const tags = [br, gz, plain].map((result) => result.headers.get("etag"));
    expect(new Set(tags).size).toBe(3);
    expect(tags[0]).toEndWith('-br"');
    expect(br.headers.get("last-modified")).toBeTruthy();

    const fresh = await get(router, "/static/app.js", "br", {
      "if-none-match": tags[0] ?? "",
    });
    expect(fresh.status).toBe(304);

    const other = await get(router, "/static/app.js", "gzip", {
      "if-none-match": tags[0] ?? "",
    });
    expect(other.status).toBe(200);
    expect(other.encoding).toBe("gzip");
  });

  it("serves a byte range of the precompressed file through a real server", async () => {
    const adapter = new BunHttpAdapter();
    adapter.useStaticAssets(assets, { prefix: "/static", precompressed: true });
    await adapter.listen(0);
    started.push(adapter);
    const response = await fetch(
      `http://127.0.0.1:${adapter.listeningPort}/static/app.js`,
      {
        headers: { "accept-encoding": "br", range: "bytes=0-9" },
        decompress: false,
      },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("content-range")).toBe(
      `bytes 0-9/${siblings["app.js.br"].length}`,
    );
    expect(
      Buffer.from(await response.bytes()).equals(
        siblings["app.js.br"].subarray(0, 10),
      ),
    ).toBe(true);
  });

  it("falls back to on-the-fly compression by default, or to identity", async () => {
    const compress = await get(
      site({ precompressed: true }),
      "/static/plain.json",
      "gzip",
    );
    expect(compress.encoding).toBe("gzip");
    expect(zlib.gunzipSync(compress.bytes).toString()).toBe(script);
    expect(compress.headers.get("vary")).toBe("Accept-Encoding");

    const identity = await get(
      site({ precompressed: { fallback: "identity" } }),
      "/static/plain.json",
      "gzip",
    );
    expect(identity.encoding).toBeNull();
    expect(identity.bytes.toString()).toBe(script);
    expect(identity.headers.get("vary")).toBe("Accept-Encoding");
  });

  it("compresses on the fly when precompressed is off, ignoring siblings", async () => {
    for (const precompressed of [undefined, false, { enabled: false }]) {
      const result = await get(
        site({ precompressed }),
        "/static/app.js",
        "gzip",
      );
      expect(result.encoding).toBe("gzip");
      expect(result.bytes.equals(siblings["app.js.gz"])).toBe(false);
      expect(zlib.gunzipSync(result.bytes).toString()).toBe(script);
      expect(result.headers.get("content-length")).toBeNull();
    }
  });

  it("applies the compression options on the fly", async () => {
    const high = await get(
      site({ compression: { threshold: "1mb" } }),
      "/static/app.js",
      "gzip",
    );
    expect(high.encoding).toBeNull();
    const zstdOnly = await get(
      site({ compression: { encodings: ["zstd"] } }),
      "/static/app.js",
      "gzip, zstd",
    );
    expect(zstdOnly.encoding).toBe("zstd");
  });

  it("compression: false sends files as they are", async () => {
    const off = await get(
      site({ compression: false }),
      "/static/app.js",
      "gzip",
    );
    expect(off.encoding).toBeNull();
    expect(off.bytes.toString()).toBe(script);

    const fallbackOff = await get(
      site({ compression: false, precompressed: true }),
      "/static/plain.json",
      "gzip",
    );
    expect(fallbackOff.encoding).toBeNull();
  });

  it("never compresses a range on the fly", async () => {
    const adapter = new BunHttpAdapter();
    adapter.useStaticAssets(assets, { prefix: "/static" });
    await adapter.listen(0);
    started.push(adapter);
    const response = await fetch(
      `http://127.0.0.1:${adapter.listeningPort}/static/plain.json`,
      {
        headers: { "accept-encoding": "gzip", range: "bytes=0-9" },
        decompress: false,
      },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe(script.slice(0, 10));
  });

  it("uses a custom extension map merged over the defaults", async () => {
    const custom = site({
      precompressed: {
        extensions: { gzip: "gzip", zstd: [] },
        fallback: "identity",
      },
    });
    const gzip = await get(custom, "/static/app.js", "gzip");
    expect(gzip.bytes.equals(siblings["app.js.gzip"])).toBe(true);
    expect((await get(custom, "/static/app.js", "zstd")).encoding).toBeNull();
    expect((await get(custom, "/static/app.js", "br")).encoding).toBe("br");
  });

  it("validates the precompressed options", () => {
    expect(() =>
      createServeStaticHandler(assets, {
        precompressed: { extensions: { gzip: "a/b" } },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createServeStaticHandler(assets, {
        precompressed: { encodings: ["deflate"] },
      }),
    ).toThrow(/not available/);
    expect(() =>
      createServeStaticHandler(assets, {
        precompressed: { extensions: { lzma: ".xz" } as never },
      }),
    ).toThrow(/unknown encoding "lzma"/);
  });

  it("keeps dotfile and traversal rules for siblings", async () => {
    const ignored = await get(
      site({ precompressed: true }),
      "/static/.hidden.js",
      "gzip",
    );
    expect(ignored.status).toBe(404);

    const allowed = await get(
      site({ precompressed: true, dotfiles: "allow" }),
      "/static/.hidden.js",
      "gzip",
    );
    expect(allowed.encoding).toBe("gzip");
    expect(allowed.bytes.equals(siblings[".hidden.js.gz"])).toBe(true);

    const escaped = await get(
      site({ precompressed: true }),
      "/static/%2e%2e/outside.js",
      "gzip",
    );
    expect(escaped.status).toBe(404);
  });

  it("serves a sibling requested by its own name as an ordinary file", async () => {
    const direct = await get(
      site({ precompressed: true }),
      "/static/app.js.gz",
      "gzip",
    );
    expect(direct.status).toBe(200);
    expect(direct.encoding).toBeNull();
    expect(direct.headers.get("content-type")).toStartWith("application/gzip");
    expect(direct.bytes.equals(siblings["app.js.gz"])).toBe(true);
  });

  it("never serves a sibling whose original is missing", async () => {
    const orphan = await get(
      site({ precompressed: true }),
      "/static/orphan.js",
      "gzip",
    );
    expect(orphan.status).toBe(404);
  });

  it("passes through useStaticAssets", async () => {
    const adapter = new BunHttpAdapter();
    adapter.useStaticAssets(assets, { prefix: "/assets", precompressed: true });
    const response = await adapter.fetch("/assets/app.js", {
      headers: { "accept-encoding": "zstd" },
    });
    expect(response.headers.get("content-encoding")).toBe("zstd");
    expect(
      Buffer.from(await response.bytes()).equals(siblings["app.js.zst"]),
    ).toBe(true);
  });
});
