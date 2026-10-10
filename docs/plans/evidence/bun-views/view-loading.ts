// Spike 5: loading .tsx views on the fly with Bun. Cold and warm import,
// what each cache-busting strategy reloads (the view, and a layout it
// imports), memory per reload, a server-side Bun.build per view as the
// loader, and fs.watch on a views tree.
//
//   NODE_ENV=production bun view-loading.ts [scratch-dir]
//
// The views are written to a scratch directory (default: a temp dir) with a
// node_modules symlink to this folder's, so `react` resolves from there.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

const root = process.argv[2] ?? mkdtempSync(join(tmpdir(), "bun-views-loading-"));
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "views", "layouts"), { recursive: true });
symlinkSync(join(import.meta.dir, "node_modules"), join(root, "node_modules"));
const page = join(root, "views", "Page.tsx");
const layout = join(root, "views", "layouts", "Main.tsx");

const writeLayout = (mark: string) =>
  writeFileSync(layout, `export function Main({ children }: { children: React.ReactNode }) {\n  return <div data-layout="${mark}">{children}</div>;\n}\n`);
const writePage = (mark: string) =>
  writeFileSync(
    page,
    `import { Main } from "./layouts/Main";\nexport interface PageProps { name: string }\nexport default function Page({ name }: PageProps) {\n  return <Main><p data-page="${mark}">Hello {name}</p></Main>;\n}\n`,
  );
writeLayout("L1");
writePage("P1");

type ViewModule = { default: (props: { name: string }) => React.ReactNode };
const render = (mod: ViewModule) => renderToString(h(mod.default, { name: "x" }));
const marks = (html: string) => `${/data-page="(\w+)"/.exec(html)?.[1]}/${/data-layout="(\w+)"/.exec(html)?.[1]}`;
const ms = (t0: number) => `${(performance.now() - t0).toFixed(2)} ms`;

console.log(`bun ${Bun.version} (${Bun.revision.slice(0, 9)}), NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}`);
console.log("\n## Native import of a .tsx view by path");
let t0 = performance.now();
let mod = (await import(page)) as ViewModule;
console.log(`cold import (transpile Page + Main): ${ms(t0)}; renders ${marks(render(mod))}`);
t0 = performance.now();
mod = (await import(page)) as ViewModule;
console.log(`warm import (module registry hit): ${ms(t0)}`);

console.log("\n## Edit, then reload — what each strategy picks up (expect page/layout = P2/L2 after editing both)");
writePage("P2");
writeLayout("L2");
mod = (await import(page)) as ViewModule;
console.log(`plain import again: ${marks(render(mod))}`);
mod = (await import(`${page}?v=2`)) as ViewModule;
console.log(`import(path + "?v=2") (query-string busting): ${marks(render(mod))}`);
delete require.cache[page];
delete require.cache[layout];
mod = (await import(page)) as ViewModule;
console.log(`delete require.cache[page] and [layout], import again: ${marks(render(mod))}`);

console.log("\n## Server-side Bun.build per view (target bun, packages external), imported from a content-hashed file");
const out = join(root, ".views-build");
mkdirSync(out, { recursive: true });
async function buildView(entry: string) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
    packages: "external",
    metafile: true,
    naming: "[name]-[hash].[ext]",
    outdir: out,
    define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development") },
  });
  if (!result.success) throw new AggregateError(result.logs, "build failed");
  const meta = typeof result.metafile === "string" ? JSON.parse(result.metafile) : result.metafile;
  return { path: result.outputs[0]!.path, inputs: Object.keys(meta?.inputs ?? {}) };
}
t0 = performance.now();
let built = await buildView(page);
console.log(`cold build: ${ms(t0)}; inputs to watch: ${JSON.stringify(built.inputs)}`);
mod = (await import(built.path)) as ViewModule;
console.log(`renders ${marks(render(mod))}`);
writeLayout("L3");
t0 = performance.now();
built = await buildView(page);
console.log(`rebuild after editing only the layout: ${ms(t0)}`);
mod = (await import(built.path)) as ViewModule;
console.log(`renders ${marks(render(mod))} (expect P2/L3)`);
const builds: number[] = [];
for (let i = 0; i < 20; i++) {
  writeLayout(`B${i}`);
  const t = performance.now();
  await buildView(page);
  builds.push(performance.now() - t);
}
console.log(`20 rebuilds: median ${builds.toSorted((a, b) => a - b)[10]!.toFixed(2)} ms`);

console.log("\n## Memory: 300 reloads of the same view");
function rssMb() {
  Bun.gc(true);
  return process.memoryUsage().rss / 1024 / 1024;
}
let base = rssMb();
for (let i = 0; i < 300; i++) {
  mod = (await import(`${page}?leak=${i}`)) as ViewModule;
  render(mod);
}
console.log(`query-string busting: RSS +${(rssMb() - base).toFixed(1)} MB over 300 reloads`);
base = rssMb();
for (let i = 0; i < 300; i++) {
  delete require.cache[page];
  delete require.cache[layout];
  mod = (await import(page)) as ViewModule;
  render(mod);
}
console.log(`require.cache deletion: RSS +${(rssMb() - base).toFixed(1)} MB over 300 reloads`);

console.log("\n## fs.watch on the views tree (recursive)");
const events: string[] = [];
const watcher = watch(join(root, "views"), { recursive: true }, (type, file) => events.push(`${type}:${file}`));
await Bun.sleep(50);
writeLayout("W1");
writeFileSync(join(root, "views", "New.tsx"), "export default () => null;\n");
await Bun.sleep(200);
watcher.close();
console.log(`events: ${JSON.stringify([...new Set(events)])}`);

rmSync(root, { recursive: true, force: true });
