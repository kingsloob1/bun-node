/**
 * Builds each UI's app into `dist/<ui>/`: the hashed files under
 * `dist/<ui>/assets/` and `dist/<ui>/manifest.json`, which its server
 * (`jobsUi()`, `docsUi()`) serves from memory. Runs on `prepack`, so the
 * published tarball never needs a consumer build step.
 *
 * Each UI also gets its mount stylesheet (embedding.md §4): the entry
 * stylesheet scoped to the mount element, hashed under `assets/` like the
 * rest and copied unhashed to `dist/<ui>/mount.css`, the file
 * `@kingsleyweb/bun-ui/<ui>/mount.css` exports for a bundling host.
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
 * bun scripts/build.ts --mount-css           # only dist/<ui>/mount.css (build:types)
 * ```
 *
 * `--mount-css` writes the unhashed mount stylesheets alone, no manifest:
 * what `exports["./<ui>/mount.css"]` names, so `bun run build:types` (whose
 * verify step needs every export target to exist) works on a tree with no
 * `dist/`. With no manifest, a UI's server never mistakes it for a build
 * and keeps building in memory.
 */
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  buildAssets,
  MOUNT_STYLESHEET,
  uiDistDir,
  uiEntry,
  writeAssets,
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
    "mount-css": { type: "boolean" },
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

if (values["mount-css"] === true) {
  for (const name of names) {
    const out = values.out ?? uiDistDir(name);
    const assets = await buildAssets({
      entry: values.entry ?? uiEntry(name),
      sourcemap: "none",
      mount: name,
    });
    const mountCss = assets.mount?.css[0];
    if (mountCss === undefined) {
      throw new Error(`building ${name} produced no mount stylesheet`);
    }
    await Bun.write(
      join(out, MOUNT_STYLESHEET),
      assets.files.get(mountCss)!.body,
    );
    process.stdout.write(`wrote ${join(out, MOUNT_STYLESHEET)}\n`);
  }
  process.exit(0);
}

for (const name of names) {
  const entry = values.entry ?? uiEntry(name);
  const out = values.out ?? uiDistDir(name);
  const started = performance.now();
  const assets = await buildAssets({ entry, check: true, mount: name });
  const manifest = await writeAssets(assets, out);
  // The unhashed copy a bundling host imports (`exports["./<ui>/mount.css"]`).
  const mountCss = assets.mount?.css[0];
  if (mountCss === undefined) {
    throw new Error(`building ${name} produced no mount stylesheet`);
  }
  await Bun.write(
    join(out, MOUNT_STYLESHEET),
    assets.files.get(mountCss)!.body,
  );

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
