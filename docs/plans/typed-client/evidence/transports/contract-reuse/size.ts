/**
 * Can the typed client reuse bun-common's browser-safe contract core
 * (`@kingsleyweb/bun-common/contract`) for its runtime checks instead of a
 * copy? Browser bundle sizes, minified and gzip, and a server-marker scan
 * (`node:`, `bun:`, `Bun.`). `bun contract-reuse/size.ts`
 */
import { join } from "node:path";
console.log("entry   min_KB  gzip_KB  server markers");
for (const name of ["guards", "whole"]) {
  const r = await Bun.build({ entrypoints: [join(import.meta.dir, `${name}.ts`)], target: "browser", minify: true, conditions: ["@kingsleyweb/source"] });
  if (!r.success) { console.log(name, "FAILED", r.logs); continue; }
  const text = await r.outputs[0]!.text();
  const bytes = new TextEncoder().encode(text);
  const markers = [...new Set(text.match(/node:[a-z_]+|bun:[a-z]+|\bBun\.[a-zA-Z]+/g) ?? [])];
  console.log(`${name.padEnd(7)} ${(bytes.length / 1024).toFixed(1).padStart(6)}  ${(Bun.gzipSync(bytes).length / 1024).toFixed(1).padStart(7)}  ${markers.join(", ") || "none"}`);
}
