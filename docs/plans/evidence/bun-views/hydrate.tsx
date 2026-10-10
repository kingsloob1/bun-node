// Spike 7: hydration. A per-view client entry bundled in memory by Bun.build,
// served by bun-common with a CSP nonce and SRI; props embedded XSS-safe;
// hydrateRoot(document) in headless Chrome (Bun.WebView), as bun-jobs-ui's
// e2e suites drive it. A heavy job (Chrome): run it through the wrapper.
//
//   NODE_ENV=production bun hydrate.tsx [scratch-dir]
//
// Three pages: props in a bootstrapScriptContent assignment (A), props in a
// <script type="application/json"> rendered by the server only (B), and an
// async server component inside the hydrated tree (C).
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToReadableStream } from "react-dom/server";
import { BunHttpAdapter, createLogger } from "../../../../packages/bun-common/lib/index.ts";

const scratch = process.argv[2] ?? mkdtempSync(join(tmpdir(), "bun-views-hydrate-"));
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, "views"), { recursive: true });
symlinkSync(join(import.meta.dir, "node_modules"), join(scratch, "node_modules"));

// Shared code: the document shell (rendered on both sides) and the view.
writeFileSync(join(scratch, "views", "Doc.tsx"), `
export function Doc({ title, children }: { title: string; children: React.ReactNode }) {
  return (<html lang="en"><head><meta charSet="utf-8" /><title>{title}</title></head><body><div id="app">{children}</div></body></html>);
}
`);
writeFileSync(join(scratch, "views", "Counter.tsx"), `
import { useEffect, useState } from "react";
export interface CounterProps { title: string; start: number; evil: string }
export default function Counter({ start, evil }: CounterProps) {
  const [count, setCount] = useState(start);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (<main data-hydrated={hydrated ? "yes" : "no"}>
    <p id="evil">{evil}</p>
    <button type="button" onClick={() => setCount((n) => n + 1)}>count {count}</button>
  </main>);
}
`);
writeFileSync(join(scratch, "views", "AsyncPage.tsx"), `
import { Suspense, useEffect, useState } from "react";
async function Slow() { await new Promise((r) => setTimeout(r, 10)); return <p id="slow">async server data</p>; }
export default function AsyncPage() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (<main data-hydrated={hydrated ? "yes" : "no"}><Suspense fallback={<p>loading</p>}><Slow /></Suspense></main>);
}
`);
// One client entry per (view, props transport).
const entry = (view: string, transport: "global" | "json") => {
  const file = join(scratch, `client-${view}-${transport}.tsx`);
  writeFileSync(file, `
import { hydrateRoot } from "react-dom/client";
import { Doc } from "./views/Doc";
import View from "./views/${view}";
const props = ${transport === "global" ? "(self as any).__RV_PROPS" : `JSON.parse(document.getElementById("__rv_props")!.textContent!)`};
hydrateRoot(document, <Doc title={props.title}><View {...props} /></Doc>, {
  onRecoverableError: (error) => console.error("recoverable: " + String(error)),
  onCaughtError: (error) => console.error("caught: " + String(error)),
  onUncaughtError: (error) => console.error("uncaught: " + String(error)),
});
`);
  return file;
};

/** JSON safe inside <script> (bun-jobs-ui's jsonForScript, lib/shell.ts). */
const jsonForScript = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
const integrityOf = (bytes: Uint8Array) => `sha384-${new Bun.CryptoHasher("sha384").update(bytes).digest("base64")}`;

console.log(`bun ${Bun.version} (${Bun.revision.slice(0, 9)}), NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}`);
console.log("\n## Bun.build of the client entries (browser, minified, splitting)");
const assets = new Map<string, { body: Uint8Array; type: string; integrity: string }>();
const entries = new Map<string, string>();
const t0 = performance.now();
const result = await Bun.build({
  entrypoints: [entry("Counter", "global"), entry("Counter", "json"), entry("AsyncPage", "global")],
  target: "browser",
  format: "esm",
  minify: true,
  splitting: true,
  naming: { entry: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]" },
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development") },
});
if (!result.success) throw new AggregateError(result.logs, "client build failed");
console.log(`cold build of 3 entries: ${(performance.now() - t0).toFixed(0)} ms`);
for (const output of result.outputs) {
  const body = new Uint8Array(await output.arrayBuffer());
  const name = output.path.split("/").at(-1)!;
  assets.set(name, { body, type: "text/javascript; charset=utf-8", integrity: integrityOf(body) });
  if (output.kind === "entry-point") entries.set(name.replace(/-[a-z0-9]+\.js$/, ""), name);
  console.log(`${output.kind} ${name}: ${(body.byteLength / 1024).toFixed(1)} KiB, gzip ${(Bun.gzipSync(body).byteLength / 1024).toFixed(1)} KiB`);
}

const { Doc } = await import(join(scratch, "views", "Doc.tsx"));
const Counter = (await import(join(scratch, "views", "Counter.tsx"))).default;
const AsyncPage = (await import(join(scratch, "views", "AsyncPage.tsx"))).default;
const props = { title: "Hydration spike", start: 5, evil: `</script><script>self.__xss=1</script> <!--` };

const adapter = new BunHttpAdapter(0, { logger: createLogger({ level: "error" }) });
const page = (mode: "A" | "B" | "C") => async (_req: unknown, res: import("../../../../packages/bun-common/lib/index.ts").BunResponse) => {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const file = entries.get(mode === "C" ? "client-AsyncPage-global" : mode === "A" ? "client-Counter-global" : "client-Counter-json")!;
  const tree =
    mode === "B" ? (
      <Doc title={props.title}>
        <Counter {...props} />
        {/* Server only: the client tree does not have this element. */}
        <script type="application/json" id="__rv_props" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonForScript(props) }} />
      </Doc>
    ) : (
      <Doc title={props.title}>{mode === "C" ? <AsyncPage /> : <Counter {...props} />}</Doc>
    );
  const stream = await renderToReadableStream(tree, {
    nonce,
    bootstrapScriptContent: mode === "B" ? undefined : `self.__RV_PROPS=${jsonForScript(props)}`,
    bootstrapModules: [{ src: `/assets/${file}`, integrity: assets.get(file)!.integrity }],
    onError: () => {},
  });
  res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic'; base-uri 'none'; object-src 'none'`);
  res.type("html").send(stream);
};
adapter.get("/a", page("A"));
adapter.get("/b", page("B"));
adapter.get("/c", page("C"));
adapter.get("/assets/:file", (req, res) => {
  const asset = assets.get((req.params as { file: string }).file);
  if (!asset) return void res.status(404).send("no such asset");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.type(asset.type).send(asset.body);
});
await adapter.listen(0, "127.0.0.1");
const origin = `http://127.0.0.1:${adapter.listeningPort}`;

const html = await (await fetch(`${origin}/a`)).text();
console.log("\n## The served HTML (page A)");
console.log(`props script present, raw </script> from props absent: ${html.includes("__RV_PROPS") && !html.includes("</script><script>self.__xss")}`);
console.log(`every <script> carries a nonce: ${(html.match(/<script[^>]*>/g) ?? []).every((t) => t.includes("nonce="))}`);
console.log(`module script carries integrity: ${/<script[^>]*type="module"[^>]*integrity="sha384-/.test(html) || /<script[^>]*integrity="sha384-[^"]+"[^>]*type="module"/.test(html)}`);
console.log(`modulepreload with integrity: ${/<link rel="modulepreload"[^>]*integrity=/.test(html)}`);

const chromePath = [process.env.BUN_CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => p && existsSync(p));
if (!chromePath) {
  console.log("\n## Chrome: SKIPPED, none found (set BUN_CHROME_PATH)");
} else {
  const profileDir = join(scratch, "chrome-profile");
  const pageConsole: string[] = [];
  const view = new Bun.WebView({
    backend: { type: "chrome", url: false, path: chromePath },
    dataStore: { directory: profileDir },
    width: 1024,
    height: 700,
    console: (type, ...args) => void pageConsole.push(`${type}: ${args.map(String).join(" ")}`),
  });
  const waitHydrated = `new Promise((resolve) => { const d = Date.now() + 10000; const c = () => { const m = document.querySelector('main'); if (m && m.dataset.hydrated === 'yes') return resolve(true); if (Date.now() > d) return resolve(false); setTimeout(c, 25); }; c(); })`;
  const violations = `new Promise((resolve) => { const o = new ReportingObserver(() => {}, { types: ["csp-violation"], buffered: true }); o.observe(); setTimeout(() => { resolve(o.takeRecords().map((r) => String(r.body.effectiveDirective) + " " + String(r.body.blockedURL))); o.disconnect(); }, 50); })`;
  console.log(`\n## Chrome (${chromePath})`);
  for (const [mode, path] of [["A: props via bootstrapScriptContent", "/a"], ["B: props in a server-only <script type=application/json>", "/b"], ["C: async server component in the hydrated tree", "/c"]] as const) {
    pageConsole.length = 0;
    const t = performance.now();
    await view.navigate(origin + path);
    const hydrated = await view.evaluate<boolean>(waitHydrated);
    const hydratedMs = performance.now() - t;
    let clicked = "n/a";
    if (path !== "/c") {
      await view.evaluate("document.querySelector('button').click()");
      await Bun.sleep(50);
      clicked = await view.evaluate<string>("document.querySelector('button').textContent");
    }
    const xss = await view.evaluate<boolean>("self.__xss === 1");
    const evilText = path === "/c" ? "n/a" : await view.evaluate<string>("JSON.stringify(document.getElementById('evil').textContent)");
    const slow = path === "/c" ? await view.evaluate<string>("document.getElementById('slow')?.textContent ?? 'missing'") : "n/a";
    const csp = await view.evaluate<string[]>(violations);
    console.log(`- ${mode}: hydrated ${hydrated} (${hydratedMs.toFixed(0)} ms from navigate), after click "${clicked}", injected script ran ${xss}, evil text round-trips as ${evilText}, async text ${JSON.stringify(slow)}, CSP violations ${JSON.stringify(csp)}`);
    console.log(`  console: ${JSON.stringify(pageConsole.filter((l) => !l.startsWith("debug")).map((l) => l.slice(0, 200)))}`);
  }
  view.close();
  await Bun.sleep(300);
}
await adapter.close();
rmSync(scratch, { recursive: true, force: true });
