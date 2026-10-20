/**
 * Express 5 behaviours of `BunResponse` / `BunRequest` that bun-nest's
 * differential test against `@nestjs/platform-express` measured, pinned here
 * at the unit level: the view system (`BunViews`, `res.render`),
 * `res.redirect`, `res.clearCookie`, the error a malformed JSON body raises,
 * and the `Content-Disposition` of `res.attachment` / `res.download`. Each
 * expected value is what Express produced for the same input: 5.2 where 5.2
 * and 5.3 agree, and 5.3.0 for the redirect's HTML body and
 * `Content-Disposition`, where they differ (the user's decision,
 * 2026-10-20). The 5.3.0 values were taken from `express@5.3.0`'s
 * `lib/response.js` and `content-disposition@2.0.1`'s `create()` run on the
 * same names.
 */
import type { RenderCallback, ViewEngine } from "../lib/views";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunResponse } from "../lib/BunResponse";
import { BunViews } from "../lib/views";
import { makeRequest, makeResponse } from "./helpers";

let root: string;
let other: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bun-common-views-"));
  other = await mkdtemp(join(tmpdir(), "bun-common-views-2-"));
  await writeFile(join(root, "page.tpl"), "page");
  await mkdir(join(root, "dir"));
  await writeFile(join(root, "dir", "index.tpl"), "dir-index");
  await writeFile(join(other, "only.tpl"), "only-in-other");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
});

/** An engine that answers `<file contents>|<locals as JSON>`, synchronously. */
const echoEngine: ViewEngine = (path, options, callback) => {
  const { settings: _s, _locals: _l, cache: _c, ...locals } = options;
  void Bun.file(path)
    .text()
    .then(
      (text) => callback(null, `${text}|${JSON.stringify(locals)}`),
      (error: Error) => callback(error),
    );
};

/** Renders `name` and resolves `[err, html]`. */
function renderWith(
  views: BunViews,
  name: string,
  options?: Record<string, unknown>,
): Promise<[Error | null, string | undefined]> {
  return new Promise((resolve) => {
    const done: RenderCallback = (err, html) => resolve([err, html]);
    views.render(name, options, done);
  });
}

function makeViews(): BunViews {
  const views = new BunViews();
  views.root = root;
  views.defaultEngine = "tpl";
  views.engine("tpl", echoEngine);
  return views;
}

describe("BunViews (Express app.render)", () => {
  it("adds the default engine's extension and merges app locals under the options", async () => {
    const views = makeViews();
    views.locals.site = "S";
    views.locals.title = "app";
    const [err, html] = await renderWith(views, "page", {
      title: "opts",
      _locals: { user: "res" },
    });
    expect(err).toBeNull();
    expect(html).toBe('page|{"site":"S","title":"opts","user":"res"}');
  });

  it("finds <name>/index.<ext> and looks through several roots in order", async () => {
    const views = makeViews();
    views.root = [other, root];
    expect((await renderWith(views, "dir"))[1]).toBe("dir-index|{}");
    expect((await renderWith(views, "only"))[1]).toBe("only-in-other|{}");
  });

  it("passes a failed lookup to the callback with Express's message", async () => {
    const views = makeViews();
    const [err] = await renderWith(views, "nope");
    expect(err?.message).toBe(
      `Failed to lookup view "nope" in views directory "${root}"`,
    );

    views.root = [other, root];
    const [many] = await renderWith(views, "nope");
    expect(many?.message).toBe(
      `Failed to lookup view "nope" in views directories "${other}" or "${root}"`,
    );
  });

  it("throws synchronously with no default engine and no extension", () => {
    const views = new BunViews();
    expect(() => views.render("page", {}, () => undefined)).toThrow(
      "No default engine was specified and no extension was provided.",
    );
  });

  it("loads an unregistered extension's module and requires an __express export", () => {
    const views = new BunViews();
    views.root = root;
    // `node:path` loads, but is no view engine.
    expect(() => views.render("x.path", {}, () => undefined)).toThrow(
      'Module "path" does not provide a view engine.',
    );
    expect(() =>
      views.render("x.no-such-engine-module", {}, () => undefined),
    ).toThrow();
  });

  it("refuses a script extension with no registered engine instead of loading a module by its name", () => {
    const views = new BunViews();
    views.root = root;
    for (const ext of ["tsx", "jsx", "ts", "js", "mjs", "cts"]) {
      expect(() => views.render(`page.${ext}`, {}, () => undefined)).toThrow(
        `No view engine registered for ".${ext}": register one with engine("${ext}", fn).`,
      );
    }
    // A registered engine for a script extension renders as any other.
    views.engine("tsx", (_path, _options, cb) => cb(null, "<p>tsx</p>"));
    expect(() => views.render("page.tsx", {}, () => undefined)).not.toThrow(
      "No view engine registered",
    );
  });

  it("defers a callback the engine calls synchronously", () => {
    const views = makeViews();
    views.engine("tpl", (_path, _options, callback) => callback(null, "sync"));
    let called = false;
    views.render("page", {}, () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  it("hands engines Express's settings", async () => {
    const views = makeViews();
    let seen: Record<string, unknown> | undefined;
    views.engine("tpl", (_path, options, callback) => {
      seen = options.settings as Record<string, unknown>;
      callback(null, "");
    });
    await renderWith(views, "page");
    expect(seen?.views).toBe(root);
    expect(seen?.["view engine"]).toBe("tpl");
  });

  it("caches a resolved view only while the cache is on", async () => {
    const views = makeViews();
    await writeFile(join(root, "gone.tpl"), "x");
    views.cache = true;
    expect((await renderWith(views, "gone"))[0]).toBeNull();
    await rm(join(root, "gone.tpl"));
    // Cached: the path is not looked up again (the engine then fails to read).
    const [cachedErr] = await renderWith(views, "gone", { cache: true });
    expect(cachedErr?.message ?? "").not.toContain("Failed to lookup view");
    const [uncachedErr] = await renderWith(views, "gone", { cache: false });
    expect(uncachedErr?.message).toContain("Failed to lookup view");
  });

  it("rejects an engine that is not a function", () => {
    expect(() =>
      new BunViews().engine("x", "nope" as unknown as ViewEngine),
    ).toThrow("callback function required");
  });
});

describe("BunResponse.render (Express res.render)", () => {
  async function responseWithViews(views = makeViews()) {
    return new BunResponse(await makeRequest(), { views });
  }

  it("sends the rendered view as text/html, with res.locals", async () => {
    const res = await responseWithViews();
    res.locals.user = "u";
    res.render("page", { a: 1 });
    const native = await res.getNativeResponse(1000);
    expect(native.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await native.text()).toBe('page|{"user":"u","a":1}');
  });

  it("keeps a Content-Type already set", async () => {
    const res = await responseWithViews();
    res.setHeader("Content-Type", "text/plain");
    res.render("page");
    const native = await res.getNativeResponse(1000);
    expect(native.headers.get("content-type")).toBe("text/plain");
  });

  it("hands an error to req.next, or answers 500 without a pipeline", async () => {
    const res = await responseWithViews();
    let passed: unknown;
    res.req.next = (err) => {
      passed = err;
    };
    res.render("nope");
    await Bun.sleep(5);
    expect((passed as Error).message).toContain('Failed to lookup view "nope"');
    expect(res.headersSent).toBe(false);

    const bare = await responseWithViews();
    bare.render("nope");
    expect((await bare.getNativeResponse(1000)).status).toBe(500);
  });

  it("calls a callback instead of sending", async () => {
    const res = await responseWithViews();
    const html = await new Promise<string | undefined>((resolve) => {
      res.render("page", (_err, out) => resolve(out));
    });
    expect(html).toBe("page|{}");
    expect(res.headersSent).toBe(false);
  });

  it("throws with no views configured and no extension, as Express", async () => {
    const res = await makeResponse();
    expect(() => res.render("index")).toThrow(
      "No default engine was specified",
    );
  });
});

describe("BunResponse.redirect (Express 5 res.redirect)", () => {
  async function redirected(
    run: (res: BunResponse) => void,
    init: { method?: string; headers?: Record<string, string> } = {},
  ) {
    const res = new BunResponse(await makeRequest(init), { etag: "weak" });
    run(res);
    const native = await res.getNativeResponse(1000);
    return {
      status: native.status,
      location: native.headers.get("location"),
      type: native.headers.get("content-type"),
      vary: native.headers.get("vary"),
      length: native.headers.get("content-length"),
      etag: native.headers.get("etag"),
      body: await native.text(),
    };
  }

  it("answers 302 with a text body for */*, and no ETag", async () => {
    expect(
      await redirected((res) => res.redirect("/target"), {
        headers: { accept: "*/*" },
      }),
    ).toEqual({
      status: 302,
      location: "/target",
      type: "text/plain; charset=utf-8",
      vary: "Accept",
      length: "29",
      etag: null,
      body: "Found. Redirecting to /target",
    });
  });

  it("takes (status, url), as Express, and still (url, status)", async () => {
    const first = await redirected((res) => res.redirect(301, "/r"));
    expect([first.status, first.location, first.body]).toEqual([
      301,
      "/r",
      "Moved Permanently. Redirecting to /r",
    ]);
    const legacy = await redirected((res) => res.redirect("/r", 307));
    expect([legacy.status, legacy.location]).toEqual([307, "/r"]);
  });

  it("negotiates an HTML body, escaped, and an empty one for neither", async () => {
    const html = await redirected((res) => res.redirect("/a?b=1&c=<x>"), {
      headers: { accept: "text/html" },
    });
    expect(html.type).toBe("text/html; charset=utf-8");
    expect(html.body).toBe(
      "<!DOCTYPE html><head><title>Found</title></head><body><p>Found. Redirecting to /a?b=1&amp;c=%3Cx%3E</p></body>",
    );
    expect(html.length).toBe("110");

    const none = await redirected((res) => res.redirect("/x"), {
      headers: { accept: "application/json" },
    });
    expect([none.type, none.length, none.body, none.vary]).toEqual([
      null,
      "0",
      "",
      "Accept",
    ]);
  });

  it('URL-encodes Location and keeps "back" literal', async () => {
    const encoded = await redirected((res) =>
      res.redirect("/a b/ü?q=1 2&x=%20"),
    );
    expect(encoded.location).toBe("/a%20b/%C3%BC?q=1%202&x=%20");
    const back = await redirected((res) => res.redirect("back"), {
      headers: { referer: "http://x.test/from" },
    });
    expect(back.location).toBe("back");
  });

  it("sends no body to HEAD but keeps the length", async () => {
    const head = await redirected((res) => res.redirect("/target"), {
      method: "HEAD",
    });
    expect([head.status, head.length, head.body]).toEqual([302, "29", ""]);
  });

  it("titles the HTML document with the status message (Express 5.3.0)", async () => {
    const moved = await redirected((res) => res.redirect(301, "/r"), {
      headers: { accept: "text/html" },
    });
    expect([moved.status, moved.type, moved.length, moved.body]).toEqual([
      301,
      "text/html; charset=utf-8",
      "116",
      "<!DOCTYPE html><head><title>Moved Permanently</title></head><body><p>Moved Permanently. Redirecting to /r</p></body>",
    ]);
  });

  it("sends the body platform-express 12.2.0 (Express 5.3.0) sent for the same redirect", async () => {
    // Measured by bun-nest's differential run against @nestjs/platform-express
    // 12.2.0 on 2026-10-20 (expressCompat.common.test.ts, GET /redir).
    const html = await redirected((res) => res.redirect(302, "/a b/ü?q=1 2"), {
      headers: { accept: "text/html" },
    });
    expect([html.location, html.length, html.body]).toEqual([
      "/a%20b/%C3%BC?q=1%202",
      "111",
      "<!DOCTYPE html><head><title>Found</title></head><body><p>Found. Redirecting to /a%20b/%C3%BC?q=1%202</p></body>",
    ]);
  });

  it("gives HEAD the HTML document's length and no body", async () => {
    const head = await redirected((res) => res.redirect("/target"), {
      method: "HEAD",
      headers: { accept: "text/html" },
    });
    // "<!DOCTYPE html><head><title>Found</title></head><body><p>Found.
    // Redirecting to /target</p></body>" is 97 bytes; Express 5.2's "<p>…</p>"
    // was 36.
    expect([head.status, head.type, head.length, head.body]).toEqual([
      302,
      "text/html; charset=utf-8",
      "97",
      "",
    ]);
  });

  it("appends to an existing Vary", async () => {
    const res = await redirected((r) => {
      r.vary("Origin");
      r.redirect("/v");
    });
    expect(res.vary).toBe("Origin, Accept");
  });
});

describe("BunResponse.clearCookie (Express 5)", () => {
  it("forces Expires to the epoch and drops maxAge", async () => {
    const res = await makeResponse();
    res.clearCookie("c", {
      path: "/p",
      maxAge: 1000,
      expires: new Date("2099-01-01"),
    });
    const cookie = res.getHeader("Set-Cookie");
    const value = Array.isArray(cookie) ? cookie[0] : cookie;
    expect(value).toContain(
      "c=; Path=/p; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
    expect(value).not.toContain("Max-Age");
  });
});

describe("a malformed JSON body", () => {
  it("is refused with a SyntaxError carrying status 400, as body-parser's", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":',
    });
    const error = req.bodyDecodingError;
    expect(error).toBeInstanceOf(SyntaxError);
    expect(error).toMatchObject({
      status: 400,
      statusCode: 400,
      type: "entity.parse.failed",
    });
  });
});

describe("Content-Disposition (Express 5.3.0, content-disposition 2.x)", () => {
  let dir = "";
  let file = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bun-common-disposition-"));
    file = join(dir, "report.csv");
    await writeFile(file, "a,b\n1,2\n");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** `res.attachment(name)`'s `Content-Disposition` and `Content-Type`. */
  async function attached(name?: string) {
    const res = await makeResponse();
    res.attachment(name);
    return [
      res.getHeader("Content-Disposition"),
      res.getHeader("Content-Type"),
    ];
  }

  /** `res.download(file, name)`'s `Content-Disposition`. */
  async function downloaded(name?: string) {
    const res = await makeResponse();
    await res.download(file, name);
    return res.getHeader("Content-Disposition");
  }

  it("leaves a token filename unquoted, and quotes one that is not a token", async () => {
    expect(await attached("/var/data/report.csv")).toEqual([
      "attachment; filename=report.csv",
      "text/csv",
    ]);
    expect(await attached("x.tar.gz")).toEqual([
      "attachment; filename=x.tar.gz",
      "application/gzip",
    ]);
    // A space, a quote and a backslash are not token characters: quoted, with
    // `"` and `\` escaped, as before.
    expect((await attached("Q1 report.csv"))[0]).toBe(
      'attachment; filename="Q1 report.csv"',
    );
    expect((await attached('say "hi".txt'))[0]).toBe(
      'attachment; filename="say \\"hi\\".txt"',
    );
  });

  it("gives a non-ASCII name an ASCII fallback and filename*", async () => {
    // ISO-8859-1 is no longer kept in the fallback: content-disposition 1.x
    // sent `filename="café.txt"` alone.
    expect(await attached("café.txt")).toEqual([
      "attachment; filename=\"caf?.txt\"; filename*=UTF-8''caf%C3%A9.txt",
      "text/plain",
    ]);
    expect((await attached("l'été (1).txt"))[0]).toBe(
      "attachment; filename=\"l'?t? (1).txt\"; filename*=UTF-8''l%27%C3%A9t%C3%A9%20%281%29.txt",
    );
    // A percent escape in an ASCII name also takes filename*; the fallback
    // is a token, so it is bare.
    expect((await attached("100%25.txt"))[0]).toBe(
      "attachment; filename=100%25.txt; filename*=UTF-8''100%2525.txt",
    );
  });

  it("is plain attachment without a name", async () => {
    expect(await attached()).toEqual(["attachment", null]);
  });

  it("download() names the file's basename, or the given name's", async () => {
    expect(await downloaded()).toBe("attachment; filename=report.csv");
    expect(await downloaded("sales.csv")).toBe(
      "attachment; filename=sales.csv",
    );
    expect(await downloaded("exports/2026/sales.csv")).toBe(
      "attachment; filename=sales.csv",
    );
    expect(await downloaded("Q1 sales.csv")).toBe(
      'attachment; filename="Q1 sales.csv"',
    );
    expect(await downloaded("résumé€.pdf")).toBe(
      "attachment; filename=\"r?sum??.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9%E2%82%AC.pdf",
    );
  });

  it("download() with an empty name falls back to the file's, as Express's `name || path`", async () => {
    expect(await downloaded("")).toBe("attachment; filename=report.csv");
  });
});
