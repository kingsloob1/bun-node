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
  buildAssets as buildDocs,
  DEFAULT_DIST_DIR as DOCS_DIST_DIR,
  DEFAULT_ENTRY as DOCS_ENTRY,
  writeAssets as writeDocs,
} from "../lib/docs/assets";
import {
  buildAssets as buildJobs,
  DEFAULT_DIST_DIR as JOBS_DIST_DIR,
  DEFAULT_ENTRY as JOBS_ENTRY,
  writeAssets as writeJobs,
} from "../lib/jobs/assets";

/** What one UI's build wrote. */
interface Built {
  /** Every file of the bundle, by its hashed name. */
  files: ReadonlyMap<string, { body: Uint8Array<ArrayBuffer>; size: number }>;
  /** The entry module's file name. */
  entryJs: string;
  /** The stylesheets the shell links. */
  css: string[];
}

/** One UI's bundle: where its app starts, where it goes, and the build that makes it. */
interface UiBuild {
  /** The app's entry module. */
  entry: string;
  /** The dist directory its server reads. */
  out: string;
  /** Builds the entry and writes it to `out`. */
  run: (entry: string, out: string) => Promise<Built>;
}

/** Every UI the package builds, by name. */
const UIS: Record<string, UiBuild> = {
  jobs: {
    entry: JOBS_ENTRY,
    out: JOBS_DIST_DIR,
    run: async (entry, out) => {
      const assets = await buildJobs({ entry, check: true });
      const manifest = await writeJobs(assets, out);
      return {
        files: assets.files,
        entryJs: manifest.entry.js,
        css: manifest.entry.css,
      };
    },
  },
  docs: {
    entry: DOCS_ENTRY,
    out: DOCS_DIST_DIR,
    run: async (entry, out) => {
      const assets = await buildDocs({ entry, check: true });
      const manifest = await writeDocs(assets, out);
      return {
        files: assets.files,
        entryJs: manifest.entry.js,
        css: manifest.entry.css,
      };
    },
  },
};

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    ui: { type: "string", multiple: true },
    entry: { type: "string" },
    out: { type: "string" },
  },
});

const names = values.ui ?? Object.keys(UIS);
for (const name of names) {
  if (!(name in UIS)) {
    process.stderr.write(
      `unknown --ui ${name}; one of ${Object.keys(UIS).join(", ")}\n`,
    );
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
  const ui = UIS[name]!;
  const entry = values.entry ?? ui.entry;
  const out = values.out ?? ui.out;
  const started = performance.now();
  const built = await ui.run(entry, out);

  const rows: string[] = [];
  let total = 0;
  let totalGzip = 0;
  for (const [file, info] of built.files) {
    const gzip = Bun.gzipSync(info.body).byteLength;
    if (!file.endsWith(".map")) {
      total += info.size;
      totalGzip += gzip;
    }
    const role =
      file === built.entryJs
        ? " (entry)"
        : built.css.includes(file)
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
