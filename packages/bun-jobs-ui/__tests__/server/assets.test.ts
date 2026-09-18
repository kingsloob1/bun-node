import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { ConfigError } from "@kingsleyweb/bun-jobs";
/**
 * The bundle: building it, writing and reading `dist/`, and serving it —
 * content types, caching, ETags, 404s, and the in-memory dev fallback.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  buildAssets,
  buildAssetsOnce,
  contentTypeFor,
  integrityOf,
  loadDistAssets,
  MANIFEST_FILE,
  writeAssets,
} from "../../lib/assets";
import { ASSET_CACHE_CONTROL } from "../../lib/jobsUi";
import {
  BROKEN_ENTRY,
  fetchShell,
  FIXTURE_ENTRY,
  fixtureUi,
  tempDir,
} from "./helpers";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

/** A dist directory built from the fixture. */
async function fixtureDist(): Promise<string> {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  await writeAssets(await buildAssets({ entry: FIXTURE_ENTRY }), dir);
  return dir;
}

describe("buildAssets", () => {
  it("emits a hashed entry, a stylesheet, a split chunk and source maps", async () => {
    const assets = await buildAssets({ entry: FIXTURE_ENTRY });
    const names = [...assets.files.keys()];

    expect(assets.source).toBe("memory");
    expect(assets.entry.js).toMatch(/^entry-[a-z0-9]+\.js$/);
    expect(assets.entry.css).toEqual([
      expect.stringMatching(/^entry-[a-z0-9]+\.css$/),
    ]);
    expect(names.some((name) => /^lazy-[a-z0-9]+\.js$/.test(name))).toBe(true);
    expect(names).toContain(`${assets.entry.js}.map`);
    // The lazy chunk's stylesheet is emitted and served, but not linked: the
    // entry's stylesheet already carries its rules.
    expect(names.some((name) => /^lazy-[a-z0-9]+\.css$/.test(name))).toBe(true);
    const entryCss = new TextDecoder().decode(
      assets.files.get(assets.entry.css[0]!)!.body,
    );
    expect(entryCss).toContain(".fixture-lazy");

    const entry = assets.files.get(assets.entry.js)!;
    expect(entry.type).toBe("text/javascript; charset=utf-8");
    expect(entry.integrity).toBe(integrityOf(entry.body));
    expect(entry.size).toBe(entry.body.byteLength);
    // Minified, production, and pointing at its map.
    const text = new TextDecoder().decode(entry.body);
    expect(text).toContain("bunJobsUiFixture");
    expect(text).toContain(`sourceMappingURL=${assets.entry.js}.map`);
  });

  it("fails with the bundler's message on a broken entry", async () => {
    await expect(buildAssets({ entry: BROKEN_ENTRY })).rejects.toThrow(
      /does-not-exist/,
    );
  });

  it("refuses a missing entry with a ConfigError", async () => {
    await expect(
      buildAssets({ entry: "/nope/main.tsx" }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("maps content types by extension", () => {
    expect(contentTypeFor("a.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("a.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("a.js.map")).toBe("application/json; charset=utf-8");
    expect(contentTypeFor("a.woff2")).toBe("font/woff2");
    expect(contentTypeFor("a.xyz", "x/y;charset=utf-8")).toBe(
      "x/y; charset=utf-8",
    );
    expect(contentTypeFor("a.xyz")).toBe("application/octet-stream");
  });
});

describe("dist/", () => {
  it("writes a manifest describing every file, and reads it back", async () => {
    const dir = await fixtureDist();
    const manifest = JSON.parse(
      readFileSync(join(dir, MANIFEST_FILE), "utf8"),
    ) as {
      version: number;
      entry: { js: string; css: string[] };
      files: Record<string, { type: string; size: number; integrity: string }>;
    };

    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.files)).toContain(manifest.entry.js);
    for (const [name, info] of Object.entries(manifest.files)) {
      const bytes = readFileSync(join(dir, "assets", name));
      expect(info.size).toBe(bytes.byteLength);
      expect(info.integrity).toBe(integrityOf(new Uint8Array(bytes)));
      expect(info.type).toBe(contentTypeFor(name));
    }

    const loaded = loadDistAssets(dir);
    expect(loaded.source).toBe("dist");
    expect(loaded.entry).toEqual(manifest.entry);
    expect([...loaded.files.keys()].sort()).toEqual(
      Object.keys(manifest.files).sort(),
    );
  });

  it("empties dist/assets before writing, so stale files do not pile up", async () => {
    const dir = await fixtureDist();
    writeFileSync(join(dir, "assets", "stale-123.js"), "old");
    await writeAssets(await buildAssets({ entry: FIXTURE_ENTRY }), dir);
    expect(existsSync(join(dir, "assets", "stale-123.js"))).toBe(false);
  });

  it("serves from dist without building, when dist is present", async () => {
    const dir = await fixtureDist();
    const { logger, events } = createTestLogger();
    const ui = fixtureUi(
      { logger },
      { distDir: dir, entry: "/does/not/exist.tsx" },
    );
    const { response, shell } = await fetchShell(ui.router, "/");
    expect(response.status).toBe(200);
    const asset = await ui.router.fetch(shell.script.src.replace("/jobs", ""));
    expect(asset.status).toBe(200);
    expect(events.some((event) => /in memory/.test(event.message))).toBe(false);
  });

  it("rejects a corrupt dist at jobsUi() time, naming the problem", async () => {
    const dir = await fixtureDist();
    const manifest = JSON.parse(
      readFileSync(join(dir, MANIFEST_FILE), "utf8"),
    ) as { entry: { js: string } };
    writeFileSync(join(dir, "assets", manifest.entry.js), "tampered");
    expect(() => fixtureUi({}, { distDir: dir })).toThrow(
      /does not match its recorded integrity/,
    );

    writeFileSync(join(dir, MANIFEST_FILE), "{ not json");
    expect(() => fixtureUi({}, { distDir: dir })).toThrow(ConfigError);

    writeFileSync(
      join(dir, MANIFEST_FILE),
      JSON.stringify({
        version: 1,
        entry: { js: "gone.js", css: [] },
        files: { "gone.js": { type: "x", size: 1, integrity: "sha384-x" } },
      }),
    );
    expect(() => fixtureUi({}, { distDir: dir })).toThrow(
      /gone\.js is missing/,
    );

    writeFileSync(
      join(dir, MANIFEST_FILE),
      JSON.stringify({ version: 2, entry: {}, files: {} }),
    );
    expect(() => fixtureUi({}, { distDir: dir })).toThrow(/manifest version/);
  });

  it("dev: false without dist is a ConfigError at jobsUi() time", () => {
    expect(() => fixtureUi({ dev: false })).toThrow(ConfigError);
    expect(() => fixtureUi({ dev: false })).toThrow(/dev: false/);
  });

  it("dev: true builds in memory even when dist is present", async () => {
    // A dist built from a differently named entry, so its files are told apart.
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const variant = join(dir, "variant.ts");
    writeFileSync(variant, "export const variant = 1;\n");
    await writeAssets(await buildAssets({ entry: variant }), join(dir, "dist"));

    const fromDist = fixtureUi({}, { distDir: join(dir, "dist") });
    expect((await fetchShell(fromDist.router, "/")).shell.script.src).toContain(
      "/jobs/assets/variant-",
    );
    const dev = fixtureUi({ dev: true }, { distDir: join(dir, "dist") });
    expect((await fetchShell(dev.router, "/")).shell.script.src).toContain(
      "/jobs/assets/entry-",
    );
  });
});

describe("the in-memory fallback", () => {
  it("builds once per entry, shared by every caller, and logs one info line", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    // A private entry, so no other test has built this path.
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, "export const once = 1;\n");

    const { logger, events } = createTestLogger();
    const [a, b] = await Promise.all([
      buildAssetsOnce(entry, logger),
      buildAssetsOnce(entry, logger),
    ]);
    const c = await buildAssetsOnce(entry, logger);
    expect(a).toBe(b);
    expect(a).toBe(c);
    const notices = events.filter((event) => /in memory/.test(event.message));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe("info");
  });

  it("answers 500 when the build fails, logs it, and tries again next time", async () => {
    const { logger, events } = createTestLogger();
    const ui = fixtureUi({ logger }, { entry: BROKEN_ENTRY });

    const first = await ui.router.fetch("/");
    expect(first.status).toBe(500);
    expect(first.headers.get("content-type")).toBe("application/problem+json");
    expect(await first.json()).toMatchObject({ code: "INTERNAL", status: 500 });
    expect(
      events.filter((event) => event.level === "error").length,
    ).toBeGreaterThanOrEqual(1);

    const second = await ui.router.fetch("/assets/x.js");
    expect(second.status).toBe(500);
    // A failed build is not memoised: a second notice shows the retry.
    expect(
      events.filter((event) => /in memory/.test(event.message)).length,
    ).toBe(2);
  });
});

describe("serving assets", () => {
  /** The UI and the path of its entry module, relative to the mount. */
  async function withEntry() {
    const ui = fixtureUi();
    const { shell } = await fetchShell(ui.router, "/");
    return {
      ui,
      js: shell.script.src.replace("/jobs", ""),
      css: shell.styles[0]!.href.replace("/jobs", ""),
      shell,
    };
  }

  it("serves JS with its content type, immutable caching and an ETag", async () => {
    const { ui, js, shell } = await withEntry();
    const response = await ui.router.fetch(js);
    const body = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(ASSET_CACHE_CONTROL);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toMatch(/^"[\w+/]+"$/);
    // What the browser will check the shell's integrity against.
    expect(integrityOf(body)).toBe(shell.script.integrity);
  });

  it("serves CSS and the split chunk and source maps", async () => {
    const { ui, css, js } = await withEntry();
    const style = await ui.router.fetch(css);
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await style.text()).toContain("color");

    const map = await ui.router.fetch(`${js}.map`);
    expect(map.status).toBe(200);
    expect(map.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );

    const entryText = await (await ui.router.fetch(js)).text();
    const chunk = /\.\/(lazy-[a-z0-9]+\.js)/.exec(entryText)?.[1];
    expect(chunk).toBeString();
    expect((await ui.router.fetch(`/assets/${chunk}`)).status).toBe(200);
  });

  it("answers a matching If-None-Match with 304 and no body", async () => {
    const { ui, js } = await withEntry();
    const etag = (await ui.router.fetch(js)).headers.get("etag")!;
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const response = await ui.router.fetch(js, {
        headers: { "if-none-match": header },
      });
      expect(response.status).toBe(304);
      expect(response.headers.get("etag")).toBe(etag);
      expect(await response.text()).toBe("");
    }
    const stale = await ui.router.fetch(js, {
      headers: { "if-none-match": '"other"' },
    });
    expect(stale.status).toBe(200);
  });

  it("answers HEAD with the length and no body", async () => {
    const { ui, js } = await withEntry();
    const size = (await (await ui.router.fetch(js)).arrayBuffer()).byteLength;
    const response = await ui.router.fetch(js, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(size));
    expect(await response.text()).toBe("");
  });

  it("404s unknown files, deeper paths and the bare assets path — never the shell", async () => {
    const { ui } = await withEntry();
    for (const path of [
      "/assets/nope.js",
      "/assets/a/b.js",
      "/assets",
      "/assets/",
      "/assets/..%2Fpackage.json",
    ]) {
      const response = await ui.router.fetch(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        type: "urn:bun-jobs:error:NOT_FOUND",
        code: "NOT_FOUND",
        status: 404,
      });
    }
  });
});
