/**
 * Builds the app into `dist/`: the hashed files under `dist/assets/` and
 * `dist/manifest.json`, which `jobsUi()` serves from memory. Runs on
 * `prepack`, so the published tarball never needs a consumer build step.
 *
 * ```bash
 * bun scripts/build.ts                      # app/main.tsx → dist/
 * bun scripts/build.ts --entry <file> --out <dir>
 * ```
 */
import process from "node:process";
import { parseArgs } from "node:util";
import {
  buildAssets,
  DEFAULT_DIST_DIR,
  DEFAULT_ENTRY,
  writeAssets,
} from "../lib/assets";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    entry: { type: "string", default: DEFAULT_ENTRY },
    out: { type: "string", default: DEFAULT_DIST_DIR },
  },
});

/** Formats a byte count as KiB with one decimal. */
function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

const started = performance.now();
const assets = await buildAssets({ entry: values.entry });
const manifest = await writeAssets(assets, values.out);

const rows: string[] = [];
let total = 0;
let totalGzip = 0;
for (const [name, file] of assets.files) {
  const gzip = Bun.gzipSync(file.body).byteLength;
  if (!name.endsWith(".map")) {
    total += file.size;
    totalGzip += gzip;
  }
  const role =
    name === manifest.entry.js
      ? " (entry)"
      : manifest.entry.css.includes(name)
        ? " (css)"
        : "";
  rows.push(
    `  ${name.padEnd(40)} ${kib(file.size).padStart(11)}  gzip ${kib(gzip).padStart(10)}${role}`,
  );
}
process.stdout.write(
  `${[
    `built ${values.entry} → ${values.out} in ${Math.round(performance.now() - started)} ms`,
    ...rows,
    `  total (without source maps): ${kib(total)}, gzip ${kib(totalGzip)}`,
  ].join("\n")}\n`,
);
