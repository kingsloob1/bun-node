// Spike 1: renderToString vs renderToReadableStream vs prerender, in process,
// on Bun, for the mid-size catalogue page (views/catalog.js).
//
//   NODE_ENV=production bun render-modes.ts     # the production React build
//   bun render-modes.ts                          # NODE_ENV unset: the dev build
//
// Every iteration renders once in each mode, in a rotating order, so machine
// load hits every mode alike (the machine is shared; blocks of one mode at a
// time were measured to drift).
import { createElement as h } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { prerender } from "react-dom/static";
import {
  CatalogBody,
  CatalogDocument,
  makeItems,
  slowRecommendations,
} from "./views/catalog.js";

const ITERATIONS = Number(process.env.ITERATIONS ?? 1000);
const items = makeItems(200);
const props = { title: "Catalogue", items };

console.log(`bun ${Bun.version} (${Bun.revision.slice(0, 9)}), NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}`);
console.log(`react-dom/server -> ${import.meta.resolve("react-dom/server")}`);
console.log(`react-dom/static -> ${import.meta.resolve("react-dom/static")}`);
console.log(`${ITERATIONS} iterations, one render per mode each, rotating order; load ${(await import("node:os")).loadavg().map((n) => n.toFixed(1)).join(" ")}`);

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  let bytes = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
  }
}

type Mode = { name: string; run: () => Promise<number> | number };
const modes: Mode[] = [
  {
    name: "renderToString(body)",
    run: () => renderToString(h(CatalogBody, props)).length,
  },
  {
    name: "renderToString(document)",
    run: () => renderToString(h(CatalogDocument, props)).length,
  },
  {
    name: "renderToReadableStream(document), drained",
    run: async () => drain(await renderToReadableStream(h(CatalogDocument, props))),
  },
  {
    name: "renderToReadableStream + allReady, drained",
    run: async () => {
      const stream = await renderToReadableStream(h(CatalogDocument, props));
      await stream.allReady;
      return drain(stream);
    },
  },
  {
    name: "prerender(document), prelude drained",
    run: async () => drain((await prerender(h(CatalogDocument, props))).prelude),
  },
];

const samples = new Map<string, number[]>(modes.map((m) => [m.name, []]));
const sizes = new Map<string, number>();
// Warm up.
for (const mode of modes) for (let i = 0; i < 50; i++) sizes.set(mode.name, await mode.run());

for (let i = 0; i < ITERATIONS; i++) {
  for (let k = 0; k < modes.length; k++) {
    const mode = modes[(i + k) % modes.length]!;
    const t0 = Bun.nanoseconds();
    await mode.run();
    samples.get(mode.name)!.push((Bun.nanoseconds() - t0) / 1e6);
  }
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
console.log("\n## Whole-page render, no Suspense (ms per render)");
console.log("mode | bytes | p50 | p90 | mean | renders/s at p50 (1 core)");
for (const mode of modes) {
  const list = samples.get(mode.name)!.toSorted((a, b) => a - b);
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  console.log(
    `${mode.name} | ${sizes.get(mode.name)} | ${pct(list, 50).toFixed(3)} | ${pct(list, 90).toFixed(3)} | ${mean.toFixed(3)} | ${(1000 / pct(list, 50)).toFixed(0)}`,
  );
}

// Time to first byte with a Suspense boundary waiting 50 ms on data.
console.log("\n## Suspense: the page plus a section that waits 50 ms (median of 15)");
const DELAY = 50;
const ttfb: Record<string, number[]> = {
  "stream: shell ready (await renderToReadableStream)": [],
  "stream: first chunk": [],
  "stream: last chunk": [],
  "prerender: prelude ready": [],
  "renderToString: returned": [],
};
let stringOut = "";
let streamOut = "";
for (let i = 0; i < 15; i++) {
  let t0 = Bun.nanoseconds();
  const stream = await renderToReadableStream(
    h(CatalogDocument, { ...props, recommendations: slowRecommendations(DELAY) }),
  );
  ttfb["stream: shell ready (await renderToReadableStream)"]!.push((Bun.nanoseconds() - t0) / 1e6);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let first = true;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (first) {
      ttfb["stream: first chunk"]!.push((Bun.nanoseconds() - t0) / 1e6);
      first = false;
    }
    text += decoder.decode(value, { stream: true });
  }
  ttfb["stream: last chunk"]!.push((Bun.nanoseconds() - t0) / 1e6);
  streamOut = text;

  t0 = Bun.nanoseconds();
  await drain((await prerender(h(CatalogDocument, { ...props, recommendations: slowRecommendations(DELAY) }))).prelude);
  ttfb["prerender: prelude ready"]!.push((Bun.nanoseconds() - t0) / 1e6);

  t0 = Bun.nanoseconds();
  try {
    stringOut = renderToString(h(CatalogDocument, { ...props, recommendations: slowRecommendations(DELAY) }));
  } catch (error) {
    stringOut = `THREW: ${String(error)}`;
  }
  ttfb["renderToString: returned"]!.push((Bun.nanoseconds() - t0) / 1e6);
}
for (const [name, list] of Object.entries(ttfb)) {
  console.log(`${name}: ${pct(list.toSorted((a, b) => a - b), 50).toFixed(2)} ms`);
}
console.log(`renderToString with a suspended section contains the fallback: ${stringOut.includes("recs-loading")}, the data: ${stringOut.includes("alpha")}`);
console.log(`stream contains the fallback: ${streamOut.includes("recs-loading")}, the data: ${streamOut.includes("alpha")}, a <template> swap marker: ${/<template/.test(streamOut)}, inline <script> for the swap: ${/<script>/.test(streamOut)}`);
