// Spike 11: the compile step, ours against what exists, each in its own
// process (Bun.plugin registrations are process-wide and cannot be undone):
// Vue through our SSR-compiling plugin (adapters/plugins/vue-sfc.ts) against
// bun-plugin-vue3 (client render functions only); Svelte through ours
// against the official bun-plugin-svelte; Svelte's experimental async mode.
//
//   NODE_ENV=production bun plugins-compare.ts          # runs every case
//   NODE_ENV=production bun plugins-compare.ts <case>   # one case
import { join } from "node:path";
import type { BunPlugin } from "bun";
import { makeItems, slow } from "./fviews/data";

const ITERATIONS = Number(process.env.ITERATIONS ?? 300);
const CASES = ["vue-ours", "vue-bun-plugin-vue3", "svelte-ours", "svelte-official", "svelte-async"] as const;
const which = process.argv[2] as (typeof CASES)[number] | undefined;

if (!which) {
  console.log(`bun ${Bun.version} (${Bun.revision.slice(0, 9)}), NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}, ${ITERATIONS} iterations per case`);
  for (const c of CASES) {
    const p = Bun.spawnSync([process.execPath, import.meta.path, c], { env: process.env, stderr: "pipe" });
    process.stdout.write(p.stdout);
    const err = p.stderr.toString().trim();
    if (err) console.log(`  stderr: ${err.split("\n").slice(0, 6).join(" | ").slice(0, 400)}`);
  }
  process.exit(0);
}

const dir = join(import.meta.dir, "fviews");
const props = { title: "Catalogue", items: makeItems(200) };
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)]!;

async function timeRenders(render: () => Promise<string>) {
  const xs: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t = performance.now();
    await render();
    xs.push(performance.now() - t);
  }
  return `p50 ${pct(xs, 0.5).toFixed(2)} ms, p90 ${pct(xs, 0.9).toFixed(2)} ms`;
}

async function clientBuild(entry: string, plugin: BunPlugin) {
  const t = performance.now();
  try {
    const r = await Bun.build({ entrypoints: [entry], target: "browser", minify: true, plugins: [plugin], define: { "process.env.NODE_ENV": '"production"', __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false" } });
    if (!r.success) return `client build FAILED: ${r.logs.map(String).join(" | ").slice(0, 200)}`;
    const size = (await r.outputs[0]!.arrayBuffer()).byteLength;
    return `client build OK in ${(performance.now() - t).toFixed(0)} ms, ${(size / 1024).toFixed(1)} KiB`;
  } catch (error) {
    return `client build threw: ${String(error).slice(0, 200)}`;
  }
}

if (which.startsWith("vue")) {
  const { createSSRApp } = await import("vue");
  const { renderToString } = await import("vue/server-renderer");
  let client: BunPlugin;
  if (which === "vue-ours") {
    const { vueSfc } = await import("./adapters/plugins/vue-sfc");
    Bun.plugin(vueSfc("server"));
    client = vueSfc("client");
  } else {
    // Importing it registers itself with Bun.plugin (a side effect), for the
    // client side only: it has no SSR compile.
    const mod = await import("bun-plugin-vue3");
    client = mod.pluginVue3({ isProduction: true });
  }
  let t = performance.now();
  const Catalog = (await import(join(dir, "vue/Catalog.vue"))).default;
  const cold = performance.now() - t;
  const render = () => renderToString(createSSRApp(Catalog, props));
  const html = await render();
  console.log(`${which}: cold load ${cold.toFixed(0)} ms; ${(html.match(/class="card"/g) ?? []).length} cards, ${Buffer.byteLength(html)} bytes; render ${await timeRenders(render)}; ${await clientBuild(join(dir, "vue/Counter.vue"), client)}`);
} else {
  const { render } = await import("svelte/server");
  let client: BunPlugin;
  if (which === "svelte-official") {
    const { SveltePlugin } = await import("bun-plugin-svelte");
    Bun.plugin(SveltePlugin({ forceSide: "server" }));
    client = SveltePlugin({ forceSide: "client" });
  } else {
    const { svelteCompile } = await import("./adapters/plugins/svelte-compile");
    Bun.plugin(svelteCompile("server", { async: which === "svelte-async" }));
    client = svelteCompile("client", { async: which === "svelte-async" });
  }
  const t = performance.now();
  const Catalog = (await import(join(dir, "svelte/Catalog.svelte"))).default;
  const cold = performance.now() - t;
  const once = async () => (await render(Catalog, { props })).body;
  const html = await once();
  console.log(`${which}: cold load ${cold.toFixed(0)} ms; ${(html.match(/class="card"/g) ?? []).length} cards, ${Buffer.byteLength(html)} bytes, whitespace between tags ${/>\s+</.test(html)}; render ${await timeRenders(once)}; ${await clientBuild(join(dir, "svelte/Counter.svelte"), client)}`);
  if (which === "svelte-async") {
    for (const name of ["AsyncPage", "AsyncBoundary"]) {
      const Page = (await import(join(dir, `svelte/${name}.svelte`))).default;
      const t0 = performance.now();
      const out = render(Page, { props: { title: "T", promise: slow(50) } });
      const sync = (() => {
        try {
          return `sync body ${JSON.stringify(out.body.slice(0, 60))}`;
        } catch (error) {
          return `sync read throws "${String(error).slice(0, 90)}"`;
        }
      })();
      const awaited = await out;
      console.log(`  ${name}: ${sync}; awaited after ${(performance.now() - t0).toFixed(0)} ms: data ${awaited.body.includes('id="recs"')}, fallback ${awaited.body.includes("recs-loading")}, head ${JSON.stringify(awaited.head.slice(0, 40))}`);
    }
  }
}
