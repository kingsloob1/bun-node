/**
 * The mount module in a UI's bundle (embedding.md §3): `app/<ui>/mount.tsx`
 * bundled beside the page (`buildAssets({ mountEntry })`, the in-memory
 * build finding it beside the page's entry), recorded in the manifest, and
 * written where `exports["./<ui>/mount"]` points; the router's `/mount.js`
 * and `/mount.css` aliases; and `xxxUiMountTags()`. Over a copy of the jobs
 * server tests' fixture app with a `mount.tsx` of its own; the fixture
 * without one is the control.
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { createDocsUi, docsUiMountTags } from "../../../lib/docs/docsUi";
import { createJobsUi, jobsUiMountTags } from "../../../lib/jobs/jobsUi";
import {
  buildAssets,
  loadDistAssets,
  MANIFEST_FILE,
  siblingMountEntry,
  writeAssets,
  writeMountExports,
} from "../../../lib/kit/assets";
import {
  MOUNT_ALIAS_CACHE_CONTROL,
  mountAliases,
} from "../../../lib/kit/serve";
import { expectUndefined } from "../../harness/assert";

const SCRATCH = mkdtempSync(join(tmpdir(), "bun-ui-mount-module-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** A copy of the fixture app; with a `mount.tsx` when `mount` is set. Its page entry. */
function fixtureApp(name: string, mount: boolean): string {
  const app = join(SCRATCH, name);
  cpSync(
    join(import.meta.dir, "..", "..", "jobs", "server", "fixtures", "app"),
    app,
    { recursive: true },
  );
  if (mount) {
    writeFileSync(
      join(app, "mount.tsx"),
      `import "./entry.css";\nexport function mountFixture(): string {\n  return "mounted";\n}\nexport async function lazyFixture() {\n  return (await import("./lazy")).markLazy;\n}\n`,
    );
  }
  return join(app, "entry.ts");
}

const WITH_MOUNT = fixtureApp("with-mount", true);
const WITHOUT_MOUNT = fixtureApp("without-mount", false);

/** The text of a bundle's file. */
function text(files: ReadonlyMap<string, { body: Uint8Array }>, name: string) {
  return new TextDecoder().decode(files.get(name)!.body);
}

describe("buildAssets({ mountEntry })", () => {
  it("bundles the mount module beside the page, its own CSS left out", async () => {
    const assets = await buildAssets({
      entry: WITH_MOUNT,
      sourcemap: "none",
      mount: "jobs",
      mountEntry: siblingMountEntry(WITH_MOUNT),
    });
    const mount = assets.mount!;
    expect(mount.js).toMatch(/^mount-[a-z0-9]+\.js$/);
    expect(mount.files).toContain(mount.js);
    expect(mount.files!.every((name) => name.endsWith(".js"))).toBe(true);
    expect(mount.files!.length).toBeGreaterThan(1); // the lazy chunk
    expect(text(assets.files, mount.js!)).toContain("mounted");
    // One stylesheet for mounting: the scoped one.
    expect(mount.css).toHaveLength(1);
    expect(mount.css[0]).toMatch(/^mount-[a-f0-9]{12}\.css$/);
  });

  it("finds the mount entry beside the page's, or none", () => {
    expect(siblingMountEntry(WITH_MOUNT)).toBe(
      join(SCRATCH, "with-mount", "mount.tsx"),
    );
    expectUndefined(siblingMountEntry(WITHOUT_MOUNT), "a mount entry");
  });

  it("is recorded in the manifest, read back, and refused when it does not match", async () => {
    const assets = await buildAssets({
      entry: WITH_MOUNT,
      sourcemap: "none",
      mount: "jobs",
      mountEntry: siblingMountEntry(WITH_MOUNT),
    });
    const dir = join(SCRATCH, "dist");
    const manifest = await writeAssets(assets, dir);
    expect(manifest.mount).toEqual(assets.mount);
    expect(loadDistAssets(dir).mount).toEqual(assets.mount);
    const record = JSON.parse(
      readFileSync(join(dir, MANIFEST_FILE), "utf8"),
    ) as { mount: Record<string, unknown> };
    for (const mount of [
      { ...record.mount, js: "mount-missing.js" },
      { ...record.mount, files: undefined },
      { ...record.mount, js: undefined },
      { ...record.mount, files: ["nope.js"] },
    ]) {
      writeFileSync(
        join(dir, MANIFEST_FILE),
        JSON.stringify({ ...record, mount }),
      );
      expect(() => loadDistAssets(dir)).toThrow("a bad mount entry");
    }
  });

  it("writes what the exports name: mount.css, and mount/index.js re-exporting the hashed module", async () => {
    const assets = await buildAssets({
      entry: WITH_MOUNT,
      sourcemap: "none",
      mount: "jobs",
      mountEntry: siblingMountEntry(WITH_MOUNT),
    });
    // As the full build: assets/ from writeAssets, then the exports.
    const dir = join(SCRATCH, "exports");
    await writeAssets(assets, dir);
    await writeMountExports(assets, dir);
    expect(readFileSync(join(dir, "mount", "index.js"), "utf8")).toBe(
      `export * from "../assets/${assets.mount!.js}";\n`,
    );
    // The module is in the tarball once: mount/ holds the index alone.
    expect(readdirSync(join(dir, "mount"))).toEqual(["index.js"]);
    expect(readFileSync(join(dir, "mount.css"), "utf8")).toBe(
      text(assets.files, assets.mount!.css[0]),
    );
    // The module works from there: its function, and its lazy chunk.
    const module = (await import(join(dir, "mount", "index.js"))) as {
      mountFixture: () => string;
      lazyFixture: () => Promise<() => void>;
    };
    expect(module.mountFixture()).toBe("mounted");
    expect(typeof (await module.lazyFixture())).toBe("function");
  });

  it("writes the module's files itself for a dist without a build (build:types), no manifest", async () => {
    const assets = await buildAssets({
      entry: WITH_MOUNT,
      sourcemap: "none",
      mount: "jobs",
      mountEntry: siblingMountEntry(WITH_MOUNT),
    });
    const dir = join(SCRATCH, "exports-only");
    await writeMountExports(assets, dir, { moduleFiles: true });
    expect(readdirSync(join(dir, "assets")).sort()).toEqual(
      [...assets.mount!.files!].sort(),
    );
    expect(existsSync(join(dir, MANIFEST_FILE))).toBe(false);
    const module = (await import(join(dir, "mount", "index.js"))) as {
      mountFixture: () => string;
    };
    expect(module.mountFixture()).toBe("mounted");
  });

  it("negative control: a bundle without a mount module has nothing to write", async () => {
    const assets = await buildAssets({
      entry: WITHOUT_MOUNT,
      sourcemap: "none",
      mount: "jobs",
    });
    expectUndefined(assets.mount?.js, "a mount module");
    await expect(
      writeMountExports(assets, join(SCRATCH, "none")),
    ).rejects.toThrow("no mount module");
  });
});

describe("a UI's router: /mount.js and /mount.css", () => {
  it("re-exports the hashed module and serves the scoped stylesheets, revalidated", async () => {
    const ui = createJobsUi(
      { apiUrl: "/jobs-api", basePath: "/jobs", logger: noopLogger },
      { entry: WITH_MOUNT, distDir: join(SCRATCH, "no-dist") },
    );
    const js = await ui.router.fetch("/mount.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(js.headers.get("cache-control")).toBe(MOUNT_ALIAS_CACHE_CONTROL);
    const body = await js.text();
    expect(body).toMatch(
      /^export \* from "\.\/assets\/mount-[a-z0-9]+\.js";\n$/,
    );
    // What it names is served.
    const named = /assets\/([^"]+)/.exec(body)![1];
    expect((await ui.router.fetch(`/assets/${named}`)).status).toBe(200);
    // A revalidation is a 304.
    const again = await ui.router.fetch("/mount.js", {
      headers: { "if-none-match": js.headers.get("etag")! },
    });
    expect(again.status).toBe(304);

    const css = await ui.router.fetch("/mount.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toStartWith('[data-bun-ui="jobs"]');
  });

  it("negative control: without a mount module, both are a 404", async () => {
    const ui = createJobsUi(
      { apiUrl: "/jobs-api", basePath: "/jobs", logger: noopLogger },
      { entry: WITHOUT_MOUNT, distDir: join(SCRATCH, "no-dist") },
    );
    expect((await ui.router.fetch("/mount.js")).status).toBe(404);
    expect((await ui.router.fetch("/mount.css")).status).toBe(404);
  });

  it("mountAliases is undefined for a bundle without a module", async () => {
    const assets = await buildAssets({
      entry: WITHOUT_MOUNT,
      sourcemap: "none",
      mount: "jobs",
    });
    expectUndefined(mountAliases(assets), "the aliases");
  });
});

describe("xxxUiMountTags()", () => {
  it("names the stylesheets and the module under basePath, with SRI", async () => {
    const ui = createJobsUi(
      { apiUrl: "/jobs-api", basePath: "/admin/jobs", logger: noopLogger },
      { entry: WITH_MOUNT, distDir: join(SCRATCH, "no-dist") },
    );
    const tags = await jobsUiMountTags(ui, { nonce: "n0nce" });
    expect(tags.module.href).toMatch(
      /^\/admin\/jobs\/assets\/mount-[a-z0-9]+\.js$/,
    );
    expect(tags.module.integrity).toStartWith("sha384-");
    expect(tags.stylesheets).toHaveLength(1);
    expect(tags.stylesheets[0].href).toMatch(
      /^\/admin\/jobs\/assets\/mount-[a-f0-9]{12}\.css$/,
    );
    expect(tags.html).toBe(
      [
        `<link rel="stylesheet" href="${tags.stylesheets[0].href}" integrity="${tags.stylesheets[0].integrity}" crossorigin="anonymous" nonce="n0nce">`,
        `<link rel="modulepreload" href="${tags.module.href}" integrity="${tags.module.integrity}" crossorigin="anonymous" nonce="n0nce">`,
      ].join("\n"),
    );
    // The digest is the served file's.
    const served = await ui.router.fetch(
      tags.module.href.slice("/admin/jobs".length),
    );
    const digest = new Bun.CryptoHasher("sha384")
      .update(new Uint8Array(await served.arrayBuffer()))
      .digest("base64");
    expect(tags.module.integrity).toBe(`sha384-${digest}`);
  });

  it("refuses an object no UI function made, and a bundle with no module", async () => {
    await expect(
      jobsUiMountTags({
        router: undefined,
        basePath: "/x",
        config: undefined,
      } as never),
    ).rejects.toThrow("needs a UI made by jobsUi()");
    const docs = createDocsUi(
      { document: "/doc.json", basePath: "/docs", logger: noopLogger },
      { entry: WITHOUT_MOUNT, distDir: join(SCRATCH, "no-dist") },
    );
    await expect(docsUiMountTags(docs)).rejects.toThrow("no mount module");
  });
});
