/**
 * Builds each UI's app into `dist/<ui>/`: the hashed files under
 * `dist/<ui>/assets/` and `dist/<ui>/manifest.json`, which its server
 * (`jobsUi()`, `docsUi()`) serves from memory. Runs on `prepack`, so the
 * published tarball never needs a consumer build step.
 *
 * Each UI also gets its mount stylesheet and module (embedding.md §3, §4):
 * the entry stylesheet scoped to the mount element and `app/<ui>/mount.tsx`
 * bundled, hashed under `assets/` like the rest (the router serves them),
 * with `dist/<ui>/mount.css` and `dist/<ui>/mount/index.js` (re-exporting
 * the hashed module) beside them, what
 * `@kingsleyweb/bun-ui/<ui>/mount.css` and `/<ui>/mount` export for a
 * bundling host.
 *
 * Each bundle is type-checked first (`Bun.build`'s `check`, the app's
 * `tsconfig.json`), so a type error fails the pack instead of shipping; it
 * costs about 175 ms. The in-memory build a server makes on a request does
 * not check.
 *
 * ```bash
 * bun scripts/build.ts                       # every UI: app/<ui>/main.tsx → dist/<ui>/
 * bun scripts/build.ts --ui docs             # one UI
 * bun scripts/build.ts --ui jobs --out <dir> # one UI, elsewhere (--entry too)
 * bun scripts/build.ts --exports             # only what exports names (build:types)
 * ```
 *
 * `--exports` writes only what the package's `exports` name in `dist/<ui>/`
 * (`mount.css`, `mount/index.js` and the mount module's files under
 * `assets/`), no manifest, so
 * `bun run build:types` (whose verify step needs every export target to
 * exist) works on a tree with no `dist/`. With no manifest, a UI's server
 * never mistakes it for a build and keeps building in memory.
 */
import process from "node:process";
import { parseArgs } from "node:util";
import {
  buildAssets,
  uiDistDir,
  uiEntry,
  uiMountEntry,
  writeAssets,
  writeMountExports,
} from "../lib/kit/assets";

/**
 * Every UI the package builds, by name: `app/<name>/main.tsx` into
 * `dist/<name>/` (the kit's `uiEntry`, `uiDistDir`). A new UI is a new name.
 */
const UIS = ["jobs", "docs", "security"] as const;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    ui: { type: "string", multiple: true },
    entry: { type: "string" },
    out: { type: "string" },
    exports: { type: "boolean" },
  },
});

const names = values.ui ?? [...UIS];
for (const name of names) {
  if (!(UIS as readonly string[]).includes(name)) {
    process.stderr.write(`unknown --ui ${name}; one of ${UIS.join(", ")}\n`);
    process.exit(2);
  }
}
if (
  (values.entry !== undefined || values.out !== undefined) &&
  names.length !== 1
) {
  process.stderr.write("--entry and --out need exactly one --ui\n");
  process.exit(2);
}

/** Formats a byte count as KiB with one decimal. */
function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

if (values.exports === true) {
  for (const name of names) {
    const out = values.out ?? uiDistDir(name);
    const assets = await buildAssets({
      entry: values.entry ?? uiEntry(name),
      sourcemap: "none",
      mount: name,
      mountEntry: uiMountEntry(name),
    });
    await writeMountExports(assets, out, { moduleFiles: true });
    process.stdout.write(`wrote ${out}/mount.css and ${out}/mount/\n`);
  }
  process.exit(0);
}

for (const name of names) {
  const entry = values.entry ?? uiEntry(name);
  const out = values.out ?? uiDistDir(name);
  const started = performance.now();
  const assets = await buildAssets({
    entry,
    check: true,
    mount: name,
    mountEntry: values.entry === undefined ? uiMountEntry(name) : undefined,
  });
  const manifest = await writeAssets(assets, out);
  // What the package's exports name: mount.css and mount/ (embedding.md §3).
  if (assets.mount?.js !== undefined) {
    await writeMountExports(assets, out);
  }

  const rows: string[] = [];
  let total = 0;
  let totalGzip = 0;
  for (const [file, info] of assets.files) {
    const gzip = Bun.gzipSync(info.body).byteLength;
    if (!file.endsWith(".map")) {
      total += info.size;
      totalGzip += gzip;
    }
    const role =
      file === manifest.entry.js
        ? " (entry)"
        : manifest.entry.css.includes(file)
          ? " (css)"
          : manifest.mount?.css.includes(file)
            ? " (mount css)"
            : file === manifest.mount?.js
              ? " (mount)"
              : "";
    rows.push(
      `  ${file.padEnd(40)} ${kib(info.size).padStart(11)}  gzip ${kib(gzip).padStart(10)}${role}`,
    );
  }
  process.stdout.write(
    `${[
      `built ${name}: ${entry} → ${out} in ${Math.round(performance.now() - started)} ms`,
      ...rows,
      `  total (without source maps): ${kib(total)}, gzip ${kib(totalGzip)}`,
    ].join("\n")}\n`,
  );
}
