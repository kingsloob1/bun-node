// Spike 9: five framework adapters through one framework-agnostic core
// (core/mini-core.ts, core/interface.ts): React, Vue 3, Svelte 5, Preact and
// Solid. For each: the compile step on the server (Bun.plugin), the cold
// load, the catalogue page (200 cards) rendered to a string and streamed,
// async data (a 50 ms promise), a throwing view, a per-view client bundle
// (Bun.build with the same compile step), and the Express engine contract
// on real Express 5. Then render time per framework, rotating order.
//
//   NODE_ENV=production bun frameworks-ssr.ts
import { join } from "node:path";
import { loadavg } from "node:os";
import express from "express";
import type { ViewAdapter } from "./core/interface";
import { buildClient, engine, loadView, renderView, streamView } from "./core/mini-core";
import { reactAdapter } from "./adapters/react";
import { vueAdapter } from "./adapters/vue";
import { svelteAdapter } from "./adapters/svelte";
import { preactAdapter } from "./adapters/preact";
import { solidAdapter } from "./adapters/solid";
import { makeItems, slow } from "./fviews/data";

const ITERATIONS = Number(process.env.ITERATIONS ?? 500);
const dir = join(import.meta.dir, "fviews");
const frameworks: { adapter: ViewAdapter; ext: string; dir: string }[] = [
  { adapter: reactAdapter(), ext: ".tsx", dir: "react" },
  { adapter: vueAdapter(), ext: ".vue", dir: "vue" },
  { adapter: svelteAdapter(), ext: ".svelte", dir: "svelte" },
  { adapter: preactAdapter(), ext: ".tsx", dir: "preact" },
  { adapter: solidAdapter({ filter: /fviews\/solid\/.*\.tsx$/ }), ext: ".tsx", dir: "solid" },
];
const view = (f: (typeof frameworks)[number], name: string) => join(dir, f.dir, `${name}${f.ext}`);
const pkg = (name: string) => require(join(import.meta.dir, "node_modules", name, "package.json")).version as string;

console.log(`bun ${Bun.version} (${Bun.revision.slice(0, 9)}), NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}, load ${loadavg().map((n) => n.toFixed(1)).join(" ")}`);
console.log(`react-dom ${pkg("react-dom")}, vue ${pkg("vue")}, svelte ${pkg("svelte")}, preact ${pkg("preact")}, preact-render-to-string ${pkg("preact-render-to-string")}, solid-js ${pkg("solid-js")}, babel-preset-solid ${pkg("babel-preset-solid")}`);

const items = makeItems(200);
const props = { title: "Catalogue", items };

async function drainTimed(stream: ReadableStream<Uint8Array>, t0: number) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let first = -1;
  let firstCard = -1;
  let firstText = "";
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (first < 0) {
      first = performance.now() - t0;
      firstText = dec.decode(value, { stream: false });
    }
    text += dec.decode(value, { stream: true });
    if (firstCard < 0 && text.includes('class="card"')) firstCard = performance.now() - t0;
  }
  return { first, firstCard, last: performance.now() - t0, text, firstText };
}

for (const f of frameworks) {
  const { adapter } = f;
  console.log(`\n## ${adapter.name} (${adapter.extensions.join(", ")}; compile step: ${adapter.plugin ? "Bun plugin" : "none, Bun loads it"})`);
  let t0 = performance.now();
  await loadView(adapter, view(f, "Catalog"));
  console.log(`cold load of Catalog (compile + import, its child views too): ${(performance.now() - t0).toFixed(1)} ms`);
  t0 = performance.now();
  await loadView(adapter, view(f, "Counter"));
  console.log(`cold load of a second view, Counter (compiler already loaded): ${(performance.now() - t0).toFixed(1)} ms`);
  t0 = performance.now();
  await loadView(adapter, view(f, "Catalog"));
  console.log(`warm load: ${(performance.now() - t0).toFixed(2)} ms`);

  const html = await renderView(adapter, view(f, "Catalog"), props);
  const cards = (html.match(/class="card"/g) ?? []).length;
  const head = html.slice(0, html.indexOf("</head>"));
  console.log(`string render: ${Buffer.byteLength(html)} bytes, ${cards} cards, <title> in <head> ${/<title>Catalogue<\/title>/.test(head)}, doctype ${html.startsWith("<!DOCTYPE html>")}, name escaped ${!html.includes("<Deluxe") && html.includes("&lt;Deluxe")}`);

  // Async data: a 50 ms promise inside the framework's suspense mechanism.
  t0 = performance.now();
  const asyncHtml = await renderView(adapter, view(f, "Catalog"), { ...props, recommendations: slow(50) });
  console.log(`string render with 50 ms data: ${(performance.now() - t0).toFixed(1)} ms, data in the page ${asyncHtml.includes('id="recs"')}, fallback in the page ${asyncHtml.includes("recs-loading")}`);

  if (adapter.renderToStream) {
    t0 = performance.now();
    const stream = await streamView(adapter, view(f, "Catalog"), { ...props, recommendations: slow(50) });
    const s = await drainTimed(stream!, t0);
    console.log(`stream with 50 ms data: first chunk ${s.first.toFixed(1)} ms (${Buffer.byteLength(s.firstText)} bytes), first card ${s.firstCard.toFixed(1)} ms, last ${s.last.toFixed(1)} ms; data ${s.text.includes('id="recs"')}, fallback sent ${s.text.includes("recs-loading")}, <title> in <head> ${/<title>Catalogue<\/title>/.test(s.text.slice(0, s.text.indexOf("</head>")))}`);
  } else {
    console.log("stream: none (the adapter has no renderToStream; the core renders the string)");
  }

  try {
    await renderView(adapter, view(f, "Broken"), {}, { onError: () => {} });
    console.log("throwing view: rendered without an error (!)");
  } catch (error) {
    console.log(`throwing view: rejects, ${JSON.stringify(String((error as Error).message ?? error)).slice(0, 80)}`);
  }

  if (adapter.name === "vue") {
    // The same view with no errorHandler: what Vue itself does.
    const { createSSRApp } = await import("vue");
    const { renderToString } = await import("vue/server-renderer");
    const quiet = console.error;
    let logged = 0;
    console.error = () => void logged++;
    try {
      const html = await renderToString(createSSRApp((await loadView(adapter, view(f, "Broken"))).default as never));
      console.log(`  without an errorHandler, Vue itself: resolves ${JSON.stringify(html)}, console.error called ${logged} time(s)`);
    } catch (error) {
      console.log(`  without an errorHandler, Vue itself: rejects, ${String(error).slice(0, 80)}`);
    } finally {
      console.error = quiet;
    }
  }

  if (adapter.clientEntry) {
    try {
      const build = await buildClient(adapter, [view(f, "Counter")]);
      let total = 0;
      let gz = 0;
      let entry = 0;
      for (const a of build.assets.values()) {
        total += a.body.byteLength;
        gz += Bun.gzipSync(a.body).byteLength;
        if (a.kind === "entry-point") entry += a.body.byteLength;
      }
      console.log(`client bundle (Counter, minified): built in ${build.ms.toFixed(0)} ms, ${build.assets.size} files, entry ${(entry / 1024).toFixed(1)} KiB, all ${(total / 1024).toFixed(1)} KiB, gzip ${(gz / 1024).toFixed(1)} KiB`);
    } catch (error) {
      console.log(`client bundle: FAILED ${String(error).slice(0, 300)}`);
      for (const log of (error as AggregateError).errors ?? []) console.log(`  ${String(log).slice(0, 300)}`);
    }
  }
}

// The Express contract: real Express 5, one engine per extension, res.render.
console.log("\n## Express 5 on Bun, res.render through each adapter's engine");
const app = express();
app.set("views", dir);
app.engine("vue", engine(frameworks[1]!.adapter));
app.engine("svelte", engine(frameworks[2]!.adapter));
app.engine("tsx", engine(frameworks[0]!.adapter));
app.locals.appName = "spike";
for (const name of ["react/Counter.tsx", "vue/Counter.vue", "svelte/Counter.svelte"]) {
  app.get(`/${name}`, (_req, res) => res.render(name, { title: "T", start: 3, evil: "</script><b>" }));
}
app.get("/vue/Broken.vue", (_req, res) => res.render("vue/Broken.vue"));
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const port = (server.address() as { port: number }).port;
for (const name of ["react/Counter.tsx", "vue/Counter.vue", "svelte/Counter.svelte", "vue/Broken.vue"]) {
  const res = await fetch(`http://127.0.0.1:${port}/${name}`);
  const body = await res.text();
  console.log(`GET /${name}: ${res.status}, count 3 rendered ${body.includes("count 3") || body.includes("count <!---->3") || /count\s*(<!--[^>]*-->)?\s*3/.test(body)}, raw </script><b> absent ${!body.includes("</script><b>")}`);
}
server.close();

// Render time per framework, rotating the order every iteration.
console.log(`\n## Render time, catalogue page (string, no async data), ${ITERATIONS} rotating iterations`);
// React twice: its adapter's default ("buffered": stream + allReady) and
// its "string" mode (renderToString), the two of the React plan's §3.2.
const timed = [...frameworks, { adapter: { ...reactAdapter({ mode: "string" }), name: "react-string" }, ext: ".tsx", dir: "react" }];
const times = new Map<string, number[]>(timed.map((f) => [f.adapter.name, []]));
for (let i = 0; i < ITERATIONS; i++) {
  for (let k = 0; k < timed.length; k++) {
    const f = timed[(i + k) % timed.length]!;
    const t = performance.now();
    await renderView(f.adapter, view(f, "Catalog"), props);
    times.get(f.adapter.name)!.push(performance.now() - t);
  }
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)]!;
for (const [name, xs] of times) {
  console.log(`${name.padEnd(12)} p50 ${pct(xs, 0.5).toFixed(2)} ms, p90 ${pct(xs, 0.9).toFixed(2)} ms, ${(1000 / pct(xs, 0.5)).toFixed(0)} renders/s at p50`);
}
console.log(`load at end ${loadavg().map((n) => n.toFixed(1)).join(" ")}`);
