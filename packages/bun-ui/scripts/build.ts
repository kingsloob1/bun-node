/**
 * Builds each UI's app into `dist/<ui>/`: the hashed files under
 * `dist/<ui>/assets/` and `dist/<ui>/manifest.json`, which its server
 * (`jobsUi()`, `docsUi()`) serves from memory. Runs on `prepack`, so the
 * published tarball never needs a consumer build step.
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
 * ```
 */
import process from "node:process";
import { parseArgs } from "node:util";
import {
  buildAssets,
  uiDistDir,
  uiEntry,
  writeAssets,
} from "../lib/kit/assets";

/**
 * Every UI the package builds, by name: `app/<name>/main.tsx` into
 * `dist/<name>/` (the kit's `uiEntry`, `uiDistDir`). A new UI is a new name.
 */
const UIS = ["jobs", "docs"] as const;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    ui: { type: "string", multiple: true },
    entry: { type: "string" },
    out: { type: "string" },
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

for (const name of names) {
  const entry = values.entry ?? uiEntry(name);
  const out = values.out ?? uiDistDir(name);
  const started = performance.now();
  const assets = await buildAssets({ entry, check: true });
  const manifest = await writeAssets(assets, out);

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
