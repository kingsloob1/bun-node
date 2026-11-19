/**
 * The mount stylesheet in a UI's bundle (`lib/kit/assets.ts`, embedding.md
 * §4): built from the page's own entry stylesheet without changing it,
 * recorded in the manifest and read back from a dist directory, scoped again
 * for a custom theme, and served by the UI's router like any asset while the
 * page never links it.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import {
  buildAssets,
  loadDistAssets,
  MANIFEST_FILE,
  writeAssets,
  withStylesheet,
} from "../../../lib/kit/assets";
import { ASSET_CACHE_CONTROL } from "../../../lib/kit/browser/shared";
import { mountGuardRule, scopeStylesheet } from "../../../lib/kit/scopeCss";
import { expectUndefined } from "../../harness/assert";
import { fetchShell, fixtureUi } from "../../jobs/server/helpers";

const SCRATCH = mkdtempSync(join(tmpdir(), "bun-ui-mount-assets-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** A copy of the jobs server tests' fixture app: one stylesheet, one split chunk. */
const FIXTURE_ENTRY = (() => {
  const app = join(SCRATCH, "app");
  cpSync(
    join(import.meta.dir, "..", "..", "jobs", "server", "fixtures", "app"),
    app,
    { recursive: true },
  );
  return join(app, "entry.ts");
})();

/** The text of a bundle's file. */
function text(files: ReadonlyMap<string, { body: Uint8Array }>, name: string) {
  return new TextDecoder().decode(files.get(name)!.body);
}

describe("buildAssets({ mount })", () => {
  it("adds the scoped entry stylesheet, leaving the page's files exactly as without it", async () => {
    const plain = await buildAssets({
      entry: FIXTURE_ENTRY,
      sourcemap: "none",
    });
    const mounted = await buildAssets({
      entry: FIXTURE_ENTRY,
      sourcemap: "none",
      mount: "jobs",
    });
    expectUndefined(plain.mount, "a plain build's mount stylesheets");
    expect(mounted.entry).toEqual(plain.entry);
    for (const [name, file] of plain.files) {
      expect(mounted.files.get(name)?.integrity).toBe(file.integrity);
    }
    const [mountName] = mounted.mount!.css;
    expect(mounted.mount).toEqual({ ui: "jobs", css: [mountName] });
    expect(mountName).toMatch(/^mount-[a-f0-9]{12}\.css$/);
    expect([...mounted.files.keys()].sort()).toEqual(
      [...plain.files.keys(), mountName].sort(),
    );
    const page = text(plain.files, plain.entry.css[0]);
    expect(text(mounted.files, mountName)).toBe(scopeStylesheet(page, "jobs"));
    expect(mounted.files.get(mountName)?.type).toBe("text/css; charset=utf-8");
  });

  it("is recorded in the manifest and read back from dist/", async () => {
    const assets = await buildAssets({
      entry: FIXTURE_ENTRY,
      sourcemap: "none",
      mount: "jobs",
    });
    const dir = join(SCRATCH, "dist-ok");
    const manifest = await writeAssets(assets, dir);
    expect(manifest.mount).toEqual(assets.mount);
    const loaded = loadDistAssets(dir);
    expect(loaded.mount).toEqual(assets.mount);
    expect(loaded.files.get(assets.mount!.css[0])?.integrity).toBe(
      assets.files.get(assets.mount!.css[0])?.integrity,
    );
  });

  it("reads a dist/ without one (an older build) as having none, and refuses a bad one", async () => {
    const assets = await buildAssets({
      entry: FIXTURE_ENTRY,
      sourcemap: "none",
    });
    const dir = join(SCRATCH, "dist-plain");
    await writeAssets(assets, dir);
    expectUndefined(loadDistAssets(dir).mount, "an older dist's mount");

    const manifest = (await Bun.file(
      join(dir, MANIFEST_FILE),
    ).json()) as Record<string, unknown>;
    for (const mount of [
      { ui: "jobs", css: ["mount-missing.css"] },
      { ui: "jobs" },
      { css: [] },
      "mount.css",
    ]) {
      writeFileSync(
        join(dir, MANIFEST_FILE),
        JSON.stringify({ ...manifest, mount }),
      );
      expect(() => loadDistAssets(dir)).toThrow("a bad mount entry");
    }
  });

  it("scopes a custom theme's stylesheet too, after the entry's", async () => {
    const assets = await buildAssets({
      entry: FIXTURE_ENTRY,
      sourcemap: "none",
      mount: "jobs",
    });
    const themed = withStylesheet(assets, "theme", ":root{--accent:#123456}");
    expect(themed.entry.css).toHaveLength(assets.entry.css.length + 1);
    expect(themed.mount!.css[0]).toBe(assets.mount!.css[0]);
    const scoped = themed.mount!.css[1];
    expect(scoped).toMatch(/^theme-mount-[a-f0-9]{12}\.css$/);
    expect(text(themed.files, scoped)).toBe(
      `${mountGuardRule("jobs")}[data-bun-ui="jobs"]{--accent:#123456}`,
    );
    // Negative control: a bundle without mount stylesheets gets no copy.
    const plain = withStylesheet(
      await buildAssets({ entry: FIXTURE_ENTRY, sourcemap: "none" }),
      "theme",
      ":root{--accent:#123456}",
    );
    expectUndefined(plain.mount, "a plain bundle's mount");
  });
});

describe("a UI's router and its mount stylesheet", () => {
  it("serves it as an immutable asset, and the page never links it", async () => {
    const ui = fixtureUi();
    const { shell, html } = await fetchShell(ui.router, "/");
    // The in-memory build the router made is the kit's: the same bytes, the same name.
    const expected = await buildAssets({ entry: FIXTURE_ENTRY, mount: "jobs" });
    const name = expected.mount!.css[0];
    expect(html).not.toContain("mount-");
    expect(shell.styles.some((style) => style.href.includes("mount-"))).toBe(
      false,
    );
    const response = await ui.router.fetch(`/assets/${name}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/css; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(ASSET_CACHE_CONTROL);
    expect(await response.text()).toStartWith(mountGuardRule("jobs"));
  });
});
