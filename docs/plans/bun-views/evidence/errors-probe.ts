// Spike 10: what a throwing view leaves behind after its render has
// rejected: unhandled rejections and timers that keep the process alive.
//
//   NODE_ENV=production bun errors-probe.ts <react|vue|vue-bare|svelte|preact|solid|solid-bare>
//
// vue-bare is Vue's renderToString with no errorHandler; solid-bare is
// Solid's renderToStringAsync (the adapter avoids both).
import { join } from "node:path";
import { renderView, loadView } from "./core/mini-core";
import { reactAdapter } from "./adapters/react";
import { vueAdapter } from "./adapters/vue";
import { svelteAdapter } from "./adapters/svelte";
import { preactAdapter } from "./adapters/preact";
import { solidAdapter } from "./adapters/solid";

const which = process.argv[2] ?? "solid";
const t0 = performance.now();
const late: string[] = [];
process.on("unhandledRejection", (reason) => void late.push(`${(performance.now() - t0).toFixed(0)} ms: unhandled rejection ${String(reason).slice(0, 80)}`));
process.on("exit", () => console.log(`${which}: process exits at ${(performance.now() - t0).toFixed(0)} ms; ${late.length ? late.join("; ") : "no unhandled rejection"}`));
const dir = join(import.meta.dir, "fviews");
const cases = {
  react: [reactAdapter(), "react/Broken.tsx"],
  vue: [vueAdapter(), "vue/Broken.vue"],
  "vue-bare": [vueAdapter(), "vue/Broken.vue"],
  svelte: [svelteAdapter(), "svelte/Broken.svelte"],
  preact: [preactAdapter(), "preact/Broken.tsx"],
  solid: [solidAdapter({ filter: /fviews\/solid\/.*\.tsx$/ }), "solid/Broken.tsx"],
} as const;
const [adapter, file] = cases[(which === "solid-bare" ? "solid" : which) as keyof typeof cases];
console.error = () => {};
if (which === "solid-bare") {
  const { createComponent } = await import("solid-js");
  const { renderToStringAsync } = await import("solid-js/web");
  const View = (await loadView(cases.solid[0], join(dir, "solid/Broken.tsx"))).default;
  // An async wrapper, as an adapter's render() is: renderToStringAsync
  // throws synchronously here, and the await turns that into a rejection.
  const r = await (async () => renderToStringAsync(() => createComponent(View as never, {})))().then(() => "resolved", (e) => `rejected: ${String(e).slice(0, 60)}`);
  console.log(`${which}: render settled at ${(performance.now() - t0).toFixed(0)} ms: ${r}`);
} else if (which === "vue-bare") {
  const { createSSRApp } = await import("vue");
  const { renderToString } = await import("vue/server-renderer");
  const html = await renderToString(createSSRApp((await loadView(adapter, join(dir, file))).default as never)).catch((e) => `rejected: ${e}`);
  console.log(`${which}: render settled at ${(performance.now() - t0).toFixed(0)} ms: ${JSON.stringify(html)}`);
} else {
  const r = await renderView(adapter, join(dir, file), {}, { onError: () => {} }).then(() => "resolved", (e) => `rejected: ${String(e).slice(0, 60)}`);
  console.log(`${which}: render settled at ${(performance.now() - t0).toFixed(0)} ms: ${r}`);
}
