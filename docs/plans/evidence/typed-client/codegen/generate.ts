/** One-shot generation: bun generate.ts → routes.gen.ts (and model.json). */
import { buildApp } from "./app";
import { buildModel } from "./describe";
import { emitRoutes } from "./emit-dts";

const t0 = performance.now();
const model = buildModel(buildApp());
const t1 = performance.now();
const ts = emitRoutes(model);
const t2 = performance.now();
await Bun.write(new URL("./routes.gen.ts", import.meta.url), ts);
await Bun.write(new URL("./model.json", import.meta.url), `${JSON.stringify(model, null, 2)}\n`);
console.log(`routes ${model.routes.length}, hash ${model.hash}, model ${(t1 - t0).toFixed(2)} ms, emit ${(t2 - t1).toFixed(2)} ms, ${ts.length} bytes`);
for (const r of model.routes) for (const w of r.warnings) console.log(`warning ${r.key}: ${w}`);
